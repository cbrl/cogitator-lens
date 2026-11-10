/**
 * Compiles the targets of a Cargo workspace with real Cargo.
 *
 * Each test needs Cargo and skips when it is absent. Each test compiles a copy of the fixture, so
 * the target directory stays out of the repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderAssembly } from '../../src/artifacts/assembly/assembly-renderer.js';
import {
	cargoArtifactDirectory,
	cargoVariant,
	parseCargoMetadata,
	type CargoWorkspace,
} from '../../src/buildsystems/cargo-metadata.js';
import type { Uri } from 'vscode';
import {
	defaultArtifactOptions,
	type CompilationVariant,
	type CompileOptions,
	type ProducedArtifact,
} from '../../src/types/index.js';
import { renderContext } from '../support/artifacts.js';
import { fixturePath, requireCommand, run } from '../support/environment.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

/** Copies the fixture workspace to a new folder, and reads its metadata with Cargo. */
async function copiedWorkspace(): Promise<{ readonly root: string; readonly workspace: CargoWorkspace }> {
	const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-cargo-test-'));
	const root = path.join(parent, 'workspace');
	await fs.promises.cp(fixturePath('cargo'), root, { recursive: true });
	const metadata = run('cargo', [
		'metadata',
		'--format-version',
		'1',
		'--no-deps',
		'--manifest-path',
		path.join(root, 'Cargo.toml'),
	]);
	assert.equal(metadata.status, 0, metadata.stderr);
	return { root, workspace: parseCargoMetadata(metadata.stdout) };
}

/** A file Uri that also makes the Uri of another file, as a diagnostic in a module file needs. */
function fileUri(file: string): Uri {
	return Object.assign(sourceUri(file), {
		with: (changes: { readonly path?: string }) =>
			fileUri(
				changes.path === undefined
					? file
					: path.normalize(process.platform === 'win32' ? changes.path.replace(/^\//u, '') : changes.path),
			),
	});
}

/** The paths of the inputs of an artifact, relative to a folder. */
function inputPaths(produced: ProducedArtifact, root: string): string[] {
	return produced.inputs.map((input) => {
		const decoded = decodeURIComponent(input.uri.replace(/^file:\/\//u, '')).replace(/^\/(?=[A-Za-z]:)/u, '');
		return path.relative(root, path.normalize(decoded)).replaceAll('\\', '/');
	});
}

async function removeWorkspace(root: string): Promise<void> {
	await fs.promises.rm(path.dirname(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function variantOf(root: string, workspace: CargoWorkspace, file: string, profile = 'release'): CompilationVariant {
	const variant = cargoVariant(fileUri(path.join(root, ...file.split('/'))), [workspace], 'cargo', () => profile);
	assert.ok(variant, `${file} has no Cargo variant`);
	return variant;
}

function compileOptions(variant: CompilationVariant): CompileOptions {
	return {
		args: variant.arguments,
		env: variant.environment,
		workingDirectory: variant.workingDirectory,
		productionOptions: defaultArtifactOptions.production,
	};
}

/** The entries of the fingerprint folder of a profile, where Cargo keeps one folder for each compiled unit. */
async function fingerprints(workspace: CargoWorkspace, profileFolder: string): Promise<string[]> {
	return (
		await fs.promises.readdir(path.join(cargoArtifactDirectory(workspace), profileFolder, '.fingerprint'))
	).sort();
}

test('cargo metadata gives each source of the workspace the target that compiles it', async (t) => {
	if (!requireCommand(t, 'cargo')) {
		return;
	}
	const { root, workspace } = await copiedWorkspace();
	try {
		assert.equal(variantOf(root, workspace, 'app/src/geometry.rs').target, 'lib');
		assert.equal(variantOf(root, workspace, 'app/src/lib.rs').target, 'lib');
		assert.equal(variantOf(root, workspace, 'app/src/main.rs').target, 'bin app');
		const tool = variantOf(root, workspace, 'app/src/bin/tool.rs');
		assert.equal(tool.target, 'bin tool');
		assert.deepEqual(tool.arguments.slice(2, 6), ['--bin', 'tool', '--features', 'extra']);
		const util = variantOf(root, workspace, 'util/src/lib.rs');
		assert.equal(util.project, 'util');
		assert.ok(util.arguments.includes(path.join(root, 'util', 'Cargo.toml')));
	} finally {
		await removeWorkspace(root);
	}
});

test('Cargo compiles a module file with its crate, and hiding library code keeps the module', async (t) => {
	if (!requireCommand(t, 'cargo')) {
		return;
	}
	const { root, workspace } = await copiedWorkspace();
	try {
		const geometry = path.join(root, 'app', 'src', 'geometry.rs');
		const variant = variantOf(root, workspace, 'app/src/geometry.rs');
		const backend = toolchainBackend('cargo', { executable: 'cargo' });
		const assembly = declaredImplementation('cargo', 'assembly');
		const display = { ...defaultArtifactOptions.display, showLibraryCode: false };
		const listing = async () => {
			const produced = await assembly.producer(
				backend,
				fileUri(geometry),
				compileOptions(variant),
				neverCancelled,
			);
			const rendered = renderAssembly(
				{ ...produced, kind: 'assembly' },
				display,
				renderContext(backend, { file: geometry }),
			);
			assert.equal(rendered.presentation, 'text');
			return { produced, text: rendered.lines.map((line) => line.text).join('\n') };
		};

		const first = await listing();
		assert.match(first.text, /manhattan/u);
		assert.match(first.text, /total/u);
		// The function of lib.rs is in the output, and the filter of library code removes it.
		assert.match(first.produced.text, /double/u);
		assert.doesNotMatch(first.text, /6double/u);
		assert.equal(first.produced.dependencyCoverage, 'complete');
		const inputs = inputPaths(first.produced, root);
		for (const input of ['app/src/geometry.rs', 'app/src/lib.rs', 'util/src/lib.rs']) {
			assert.ok(inputs.includes(input), `${input} is not an input: ${inputs.join(', ')}`);
		}
		// rustc names the module file relative to the root of the workspace.
		assert.deepEqual(
			first.produced.diagnostics.map((diagnostic) => [
				path.relative(root, diagnostic.uri.fsPath).replaceAll('\\', '/'),
				diagnostic.line + 1,
				diagnostic.severity,
			]),
			[['app/src/geometry.rs', 11, 'warning']],
		);

		// With the same arguments, Cargo compiles the target again, and it adds no unit.
		const units = await fingerprints(workspace, 'release');
		const second = await listing();
		assert.equal(second.text, first.text);
		assert.deepEqual(await fingerprints(workspace, 'release'), units);
	} finally {
		await removeWorkspace(root);
	}
});

test('Cargo gives the LLVM IR, the MIR, and the remarks of a crate', async (t) => {
	if (!requireCommand(t, 'cargo')) {
		return;
	}
	const { root, workspace } = await copiedWorkspace();
	try {
		const source = fileUri(path.join(root, 'app', 'src', 'lib.rs'));
		const options = compileOptions(variantOf(root, workspace, 'app/src/lib.rs'));
		const backend = toolchainBackend('cargo', { executable: 'cargo' });
		const produce = (kind: 'llvm-ir' | 'rust-mir' | 'optimization-remarks') =>
			declaredImplementation('cargo', kind).producer(backend, source, options, neverCancelled);

		assert.match((await produce('llvm-ir')).text, /define .*6double/u);
		assert.match((await produce('rust-mir')).text, /fn double\(/u);
		// The release profile optimizes, so the inliner reports the code that it inlined into total.
		const remarks = await produce('optimization-remarks');
		// The legacy symbol form of rustc 1.93 ends with a hash, and the v0 form of rustc 1.97 does not.
		assert.match(remarks.text, /inlined into '\w*8geometry5total\w*'/u);
	} finally {
		await removeWorkspace(root);
	}
});
