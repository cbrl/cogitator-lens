/**
 * The demangler reads the output of an auxiliary tool after its normalization, in the environment
 * that the toolchain prepared for the compile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { binaryDisassemblyProducer } from '../../src/artifacts/binary-disassembly/binary-disassembly-producer.js';
import { ToolchainBackend } from '../../src/toolchains/toolchain-backend.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { neverCancelled, sourceUri, testToolchainHost, toolchainProfile } from '../support/toolchains.js';

/** A compiler stand-in that writes the object file that `-o` names. */
const fakeCompiler = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('-o') + 1], 'object');
`;

/**
 * A disassembler stand-in. Its output is a script, and the demangler is Node, which runs the script
 * that it reads. So the demangled text shows the environment of the demangler.
 */
const fakeDisassembler = String.raw`
process.stdout.write("process.stdout.write('RAW ' + process.env.COGLENS_PREPARED)");
`;

test('the disassembly demangles its normalized output in the prepared environment', async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-demangle-'));
	try {
		const compiler = path.join(directory, 'fake-gcc.cjs');
		const tool = path.join(directory, 'fake-objdump.cjs');
		const source = path.join(directory, 'main.c');
		await fs.promises.writeFile(compiler, fakeCompiler);
		await fs.promises.writeFile(tool, fakeDisassembler);
		await fs.promises.writeFile(source, 'int main(void) { return 0; }\n');
		const backend = new ToolchainBackend(
			toolchainProfile('gcc', {
				executable: process.execPath,
				defaultArguments: [compiler],
				tools: {
					disassembler: { executable: process.execPath, inputMode: 'file-argument' },
					demangler: { executable: process.execPath, inputMode: 'stdin' },
				},
			}),
			{
				...toolchainDefinitions.gcc,
				prepareEnvironment: (_profile, environment) =>
					Promise.resolve({ ...environment, COGLENS_PREPARED: 'prepared' }),
			},
			testToolchainHost,
		);
		const producer = binaryDisassemblyProducer({
			tool: 'disassembler',
			arguments: () => [tool],
			normalizeOutput: (output) => output.replace('RAW', 'normalized'),
		});
		const produce = (demangle: boolean) =>
			producer(
				backend,
				sourceUri(source),
				{
					workingDirectory: directory,
					productionOptions: { ...defaultArtifactOptions.production, demangle },
				},
				neverCancelled,
			);

		assert.equal((await produce(true)).text, 'normalized prepared');
		assert.equal((await produce(false)).text, "process.stdout.write('normalized ' + process.env.COGLENS_PREPARED)");
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});
