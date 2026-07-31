import assert from 'node:assert/strict';
import test from 'node:test';
import { intelOutputArguments } from '../src/toolchains/toolchain-backend.js';
import { windowsDemangle } from '../src/toolchains/msvc.js';
import { toolchainDefinitions } from '../src/toolchains/toolchain-map.js';

test('Intel syntax arguments respect selectable and inherent toolchain modes', () => {
	assert.deepEqual(
		intelOutputArguments(toolchainDefinitions.gcc, { intel: true, demangle: false }),
		['-masm=intel'],
	);
	assert.deepEqual(
		intelOutputArguments(toolchainDefinitions.gcc, { intel: false, demangle: false }),
		[],
	);
	assert.deepEqual(
		intelOutputArguments(toolchainDefinitions.msvc, { intel: true, demangle: false }),
		[],
	);
	assert.deepEqual(
		intelOutputArguments(
			{ intelSyntax: 'selectable', intelArguments: undefined },
			{ intel: true, demangle: false },
		),
		[],
	);
});

test('Windows demangling uses the shared stdin path for non-undname tools', async () => {
	const output = await windowsDemangle(
		'process.stdout.write("demangled-symbol")',
		process.execPath,
		process.env,
		process.cwd(),
		neverCancelled,
	);
	assert.equal(output, 'demangled-symbol');
});

const neverCancelled = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Parameters<typeof windowsDemangle>[4];
