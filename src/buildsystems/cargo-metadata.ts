import path from 'node:path';
import type { Uri } from 'vscode';
import { endOfCargoOptions } from '../toolchains/cargo.js';
import { relativeWithin } from '../services/path-variables.js';
import { localFileComparisonKey, sourceUriComparisonKey } from '../file-identity.js';
import type { CompilationVariant } from '../types/index.js';

export const cargoProviderId = 'cargo';

/** The kinds of Cargo targets that compile one crate. A build script is left out. */
export type CargoTargetKind = 'lib' | 'bin' | 'example' | 'test' | 'bench';

export interface CargoTarget {
	readonly name: string;
	readonly kind: CargoTargetKind;
	/** The root file of the crate. */
	readonly sourcePath: string;
	readonly requiredFeatures: readonly string[];
}

export interface CargoPackage {
	readonly name: string;
	readonly manifestPath: string;
	readonly directory: string;
	readonly targets: readonly CargoTarget[];
}

export interface CargoWorkspace {
	readonly root: string;
	readonly targetDirectory: string;
	/** The members of the workspace. */
	readonly packages: readonly CargoPackage[];
}

/** The order of the targets that compile the same folder. The binaries of a package usually use its library. */
const kindOrder: readonly CargoTargetKind[] = ['lib', 'bin', 'example', 'test', 'bench'];

/** Each library crate type of the metadata, such as `rlib` and `proc-macro`, selects the library with `--lib`. */
const libraryKinds = new Set(['lib', 'rlib', 'dylib', 'cdylib', 'staticlib', 'proc-macro']);

/**
 * Reads the output of `cargo metadata --format-version 1 --no-deps`. With `--no-deps`, the packages
 * are the members of the workspace.
 */
export function parseCargoMetadata(text: string): CargoWorkspace {
	const metadata = JSON.parse(text) as {
		workspace_root?: unknown;
		target_directory?: unknown;
		packages?: unknown;
	};
	if (typeof metadata.workspace_root !== 'string' || typeof metadata.target_directory !== 'string') {
		throw new Error('The Cargo metadata has no workspace root or target directory.');
	}
	const packages = Array.isArray(metadata.packages) ? (metadata.packages as unknown[]) : [];
	return {
		root: metadata.workspace_root,
		targetDirectory: metadata.target_directory,
		packages: packages.flatMap((entry) => {
			const cargoPackage = entry as { name?: unknown; manifest_path?: unknown; targets?: unknown };
			if (typeof cargoPackage.name !== 'string' || typeof cargoPackage.manifest_path !== 'string') {
				return [];
			}
			const targets = Array.isArray(cargoPackage.targets) ? (cargoPackage.targets as unknown[]) : [];
			return [
				{
					name: cargoPackage.name,
					manifestPath: cargoPackage.manifest_path,
					directory: path.dirname(cargoPackage.manifest_path),
					targets: targets.flatMap(parseTarget),
				},
			];
		}),
	};
}

function parseTarget(entry: unknown): CargoTarget[] {
	const target = entry as { name?: unknown; kind?: unknown; src_path?: unknown; 'required-features'?: unknown };
	const kinds = Array.isArray(target.kind) ? target.kind.filter((kind) => typeof kind === 'string') : [];
	const kind: CargoTargetKind | undefined = kinds.some((value) => libraryKinds.has(value))
		? 'lib'
		: kindOrder.find((candidate) => kinds.includes(candidate));
	if (!kind || typeof target.name !== 'string' || typeof target.src_path !== 'string') {
		return [];
	}
	const features = target['required-features'];
	return [
		{
			name: target.name,
			kind,
			sourcePath: target.src_path,
			requiredFeatures: Array.isArray(features)
				? features.filter((feature): feature is string => typeof feature === 'string')
				: [],
		},
	];
}

/**
 * The package and the target that compile a source file. The package is the deepest one whose folder
 * holds the file, so a member inside another package has its own files. The target is the one
 * whose root is the file, or else the one whose root folder holds the file most closely. A tie goes
 * to the earliest kind in `kindOrder`, then to the first target of the metadata.
 */
export function cargoTargetOfFile(
	file: string,
	workspaces: readonly CargoWorkspace[],
):
	| { readonly workspace: CargoWorkspace; readonly cargoPackage: CargoPackage; readonly target: CargoTarget }
	| undefined {
	const owner = workspaces
		.flatMap((workspace) => workspace.packages.map((cargoPackage) => ({ workspace, cargoPackage })))
		.filter(({ cargoPackage }) => relativeWithin(cargoPackage.directory, file) !== undefined)
		.sort((left, right) => right.cargoPackage.directory.length - left.cargoPackage.directory.length)[0];
	if (!owner) {
		return undefined;
	}
	const candidates = owner.cargoPackage.targets.flatMap((target, index) => {
		const relative = relativeWithin(path.dirname(target.sourcePath), file);
		if (relative === undefined) {
			return [];
		}
		const root = relativeWithin(target.sourcePath, file) === '';
		return [{ target, index, root, depth: path.dirname(target.sourcePath).length }];
	});
	const [selected] = candidates.sort(
		(left, right) =>
			Number(right.root) - Number(left.root) ||
			right.depth - left.depth ||
			kindOrder.indexOf(left.target.kind) - kindOrder.indexOf(right.target.kind) ||
			left.index - right.index,
	);
	return selected ? { ...owner, target: selected.target } : undefined;
}

/** The target directory of the compiles. A separate directory does not wait for the lock of the directory of rust-analyzer and of the user's builds. */
export function cargoArtifactDirectory(workspace: CargoWorkspace): string {
	return path.join(workspace.targetDirectory, 'coglens');
}

/** The Cargo options of a variant. They end with `--`, so the arguments that follow them go to rustc. */
export function cargoVariantArguments(
	workspace: CargoWorkspace,
	cargoPackage: CargoPackage,
	target: CargoTarget,
	profile: string,
): readonly string[] {
	return [
		'--manifest-path',
		cargoPackage.manifestPath,
		...(target.kind === 'lib' ? ['--lib'] : [`--${target.kind}`, target.name]),
		...(target.requiredFeatures.length > 0 ? ['--features', target.requiredFeatures.join(',')] : []),
		'--profile',
		profile,
		'--target-dir',
		cargoArtifactDirectory(workspace),
		endOfCargoOptions,
	];
}

/**
 * The environment of a variant. A configured `build.build-dir` would otherwise keep the
 * intermediate files of the compiles in the build directory of the user.
 */
export function cargoVariantEnvironment(workspace: CargoWorkspace): Readonly<Record<string, string>> {
	return { CARGO_BUILD_BUILD_DIR: cargoArtifactDirectory(workspace) };
}

/** Names a target as Cargo does, such as `lib` or `bin demo`. A library has the name of its package. */
export function cargoTargetLabel(cargoPackage: CargoPackage, target: CargoTarget): string {
	return target.kind === 'lib' && target.name === cargoPackage.name.replaceAll('-', '_')
		? 'lib'
		: `${target.kind} ${target.name}`;
}

/**
 * The variant of the target that compiles the source, with the profile of its package. One variant
 * for each source does not ask for a choice when a source opens. rustc runs in the root of the
 * workspace, so the relative paths of its diagnostics and dep-info start there.
 */
export function cargoVariant(
	source: Uri,
	workspaces: readonly CargoWorkspace[],
	toolchainProfileId: string,
	profileOf: (cargoPackage: CargoPackage) => string,
): CompilationVariant | undefined {
	const owner = cargoTargetOfFile(source.fsPath, workspaces);
	if (!owner) {
		return undefined;
	}
	const { workspace, cargoPackage, target } = owner;
	const profile = profileOf(cargoPackage);
	const targetLabel = cargoTargetLabel(cargoPackage, target);
	const targetKey = `${localFileComparisonKey(cargoPackage.manifestPath)}|${target.kind}:${target.name}`;
	return {
		id: `${cargoProviderId}:${targetKey}|${profile}|${sourceUriComparisonKey(source)}`,
		provider: cargoProviderId,
		project: cargoPackage.name,
		target: targetLabel,
		configuration: profile,
		source,
		toolchainProfileId,
		workingDirectory: workspace.root,
		arguments: cargoVariantArguments(workspace, cargoPackage, target, profile),
		environment: cargoVariantEnvironment(workspace),
		displayLabel: `Cargo · ${cargoPackage.name} ${targetLabel} · ${profile}`,
	};
}

/**
 * Reads the workspace of each manifest, the shallow manifests first. A manifest of a member of a
 * workspace that is already read is not read again. A manifest that `readMetadata` cannot read
 * gives no workspace.
 */
export async function readCargoWorkspaces(
	manifests: readonly string[],
	readMetadata: (manifest: string) => Promise<CargoWorkspace | undefined>,
): Promise<CargoWorkspace[]> {
	const depth = (manifest: string): number => path.resolve(manifest).split(path.sep).length;
	const sorted = [...manifests].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
	const readManifests = new Set<string>();
	const roots = new Set<string>();
	const workspaces: CargoWorkspace[] = [];
	for (const manifest of sorted) {
		if (readManifests.has(localFileComparisonKey(manifest))) {
			continue;
		}
		const workspace = await readMetadata(manifest);
		if (!workspace) {
			continue;
		}
		readManifests.add(localFileComparisonKey(manifest));
		workspace.packages.forEach((cargoPackage) =>
			readManifests.add(localFileComparisonKey(cargoPackage.manifestPath)),
		);
		const root = localFileComparisonKey(workspace.root);
		if (!roots.has(root)) {
			roots.add(root);
			workspaces.push(workspace);
		}
	}
	return workspaces;
}
