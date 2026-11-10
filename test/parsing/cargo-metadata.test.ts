import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
	cargoTargetOfFile,
	cargoVariant,
	parseCargoMetadata,
	readCargoWorkspaces,
	type CargoWorkspace,
} from '../../src/buildsystems/cargo-metadata.js';
import { sourceUri } from '../support/toolchains.js';

const root = path.resolve('cargo-fixtures', 'workspace');
const at = (...segments: string[]): string => path.join(root, ...segments);

/** The metadata of a workspace with a library and binaries, a member inside it, and a build script. */
function metadata(): string {
	const target = (kind: string[], name: string, file: string, extra: object = {}) => ({
		kind,
		crate_types: kind,
		name,
		src_path: file,
		...extra,
	});
	return JSON.stringify({
		workspace_root: root,
		target_directory: at('target'),
		packages: [
			{
				name: 'app-core',
				manifest_path: at('Cargo.toml'),
				targets: [
					target(['lib'], 'app_core', at('src', 'lib.rs')),
					target(['bin'], 'app-core', at('src', 'main.rs')),
					target(['bin'], 'alpha', at('src', 'bin', 'alpha.rs')),
					target(['bin'], 'beta', at('src', 'bin', 'beta', 'main.rs'), { 'required-features': ['fast', 7] }),
					target(['example'], 'demo', at('examples', 'demo.rs')),
					target(['test'], 'smoke', at('tests', 'smoke.rs')),
					target(['custom-build'], 'build-script-build', at('build.rs')),
				],
			},
			{
				name: 'macros',
				manifest_path: at('macros', 'Cargo.toml'),
				targets: [target(['proc-macro'], 'macros', at('macros', 'src', 'lib.rs'))],
			},
			{ name: 'broken' },
		],
	});
}

test('the Cargo metadata gives the members, their targets, and the target directory', () => {
	const workspace = parseCargoMetadata(metadata());
	assert.equal(workspace.root, root);
	assert.equal(workspace.targetDirectory, at('target'));
	assert.deepEqual(
		workspace.packages.map((cargoPackage) => [cargoPackage.name, cargoPackage.directory]),
		[
			['app-core', root],
			['macros', at('macros')],
		],
	);
	const [app, macros] = workspace.packages;
	// The build script compiles no crate of the package, so it is no target.
	assert.deepEqual(
		app.targets.map((target) => `${target.kind} ${target.name}`),
		['lib app_core', 'bin app-core', 'bin alpha', 'bin beta', 'example demo', 'test smoke'],
	);
	assert.deepEqual(app.targets[3].requiredFeatures, ['fast']);
	assert.equal(macros.targets[0].kind, 'lib');
	assert.throws(() => parseCargoMetadata('{"packages":[]}'), /no workspace root/u);
});

test('each source gets the target whose root holds it most closely, and a library before a binary', () => {
	const workspaces = [parseCargoMetadata(metadata())];
	const targetOf = (...segments: string[]) => {
		const owner = cargoTargetOfFile(at(...segments), workspaces);
		return owner && `${owner.cargoPackage.name} ${owner.target.kind} ${owner.target.name}`;
	};
	assert.equal(targetOf('src', 'lib.rs'), 'app-core lib app_core');
	assert.equal(targetOf('src', 'main.rs'), 'app-core bin app-core');
	// A module file beside the roots of the library and the binary belongs to the library.
	assert.equal(targetOf('src', 'geometry', 'mod.rs'), 'app-core lib app_core');
	assert.equal(targetOf('src', 'bin', 'alpha.rs'), 'app-core bin alpha');
	// A module of a binary folder belongs to its binary. A shared file of the folder goes to the first binary.
	assert.equal(targetOf('src', 'bin', 'beta', 'parse.rs'), 'app-core bin beta');
	assert.equal(targetOf('src', 'bin', 'shared.rs'), 'app-core bin alpha');
	assert.equal(targetOf('examples', 'demo.rs'), 'app-core example demo');
	assert.equal(targetOf('tests', 'common', 'mod.rs'), 'app-core test smoke');
	// A member in a folder of another package has its own files.
	assert.equal(targetOf('macros', 'src', 'expand.rs'), 'macros lib macros');
	assert.equal(targetOf('build.rs'), undefined);
	assert.equal(targetOf('benches', 'speed.rs'), undefined);
	assert.equal(cargoTargetOfFile(path.resolve('elsewhere', 'main.rs'), workspaces), undefined);
});

test('a Cargo variant selects the target, its required features, the profile, and its own target directory', () => {
	const workspace = parseCargoMetadata(metadata());
	const variant = (profile: string, ...segments: string[]) =>
		cargoVariant(sourceUri(at(...segments)), [workspace], 'cargo-profile', () => profile);

	const library = variant('release', 'src', 'geometry', 'mod.rs');
	assert.ok(library);
	assert.deepEqual(library.arguments, [
		'--manifest-path',
		at('Cargo.toml'),
		'--lib',
		'--profile',
		'release',
		'--target-dir',
		at('target', 'coglens'),
		'--',
	]);
	assert.deepEqual(library.environment, { CARGO_BUILD_BUILD_DIR: at('target', 'coglens') });
	assert.equal(library.workingDirectory, root);
	assert.equal(library.toolchainProfileId, 'cargo-profile');
	assert.equal(library.displayLabel, 'Cargo · app-core lib · release');
	assert.equal(library.configuration, 'release');
	assert.equal(library.project, 'app-core');

	const beta = variant('dev', 'src', 'bin', 'beta', 'main.rs');
	assert.ok(beta);
	assert.deepEqual(beta.arguments.slice(2, 8), ['--bin', 'beta', '--features', 'fast', '--profile', 'dev']);
	assert.equal(beta.displayLabel, 'Cargo · app-core bin beta · dev');
	// The profile is in the ID, so a new profile is a new variant.
	assert.notEqual(variant('dev', 'src', 'lib.rs')?.id, variant('release', 'src', 'lib.rs')?.id);
	assert.equal(variant('dev', 'build.rs'), undefined);
});

test('the workspaces of the manifests are read once, the shallow manifests first', async () => {
	const workspace = parseCargoMetadata(metadata());
	const broken = path.resolve('broken', 'Cargo.toml');
	const otherManifest = path.resolve('other', 'Cargo.toml');
	const other: CargoWorkspace = {
		root: path.dirname(otherManifest),
		targetDirectory: path.resolve('other', 'target'),
		packages: [],
	};
	const read: string[] = [];
	const workspaces = await readCargoWorkspaces(
		[at('macros', 'Cargo.toml'), at('Cargo.toml'), otherManifest, broken, otherManifest],
		async (manifest) => {
			read.push(manifest);
			return manifest === broken ? undefined : manifest === otherManifest ? other : workspace;
		},
	);
	// The member manifest of the read workspace is not read again, and a failed manifest gives nothing.
	assert.deepEqual(read, [broken, otherManifest, at('Cargo.toml')]);
	assert.deepEqual(workspaces, [other, workspace]);
});
