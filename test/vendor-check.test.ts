import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..');
const vendorRoot = path.join(repositoryRoot, 'src', 'vendor');

async function readVendoredFile(relativePath: string): Promise<string> {
	return fs.readFile(path.join(vendorRoot, relativePath), 'utf8');
}

async function readUpstreamFixture(relativePath: string): Promise<string> {
	if (relativePath.startsWith('etc/scripts/docenizers/')) {
		return fs.readFile(path.join(
			repositoryRoot,
			'scripts',
			'compiler-explorer-docenizers',
			relativePath.slice('etc/scripts/docenizers/'.length),
		), 'utf8');
	}
	const content = await readVendoredFile(relativePath);
	return relativePath.startsWith('lib/asm-docs/generated/')
		? content.replace(/\n    return undefined;\n\}\s*$/u, '\n}\n')
		: content;
}

async function loadCheckVendoredFiles() {
	const module = await import('../scripts/vendor-check.mjs');
	return module.checkVendoredFiles;
}

test('reports only vendored files that differ from upstream', async () => {
	const checkVendoredFiles = await loadCheckVendoredFiles();
	const matching = await checkVendoredFiles('deadbeef', (_revision: string, upstreamPath: string) =>
		readUpstreamFixture(upstreamPath));
	const mismatching = await checkVendoredFiles('deadbeef', (_revision: string, upstreamPath: string) =>
		upstreamPath === 'lib/parsers/asmregex.ts' ? Promise.resolve('different content') : readUpstreamFixture(upstreamPath));
	assert.deepEqual(matching, []);
	assert.deepEqual(mismatching, ['src/vendor/lib/parsers/asmregex.ts']);
});
