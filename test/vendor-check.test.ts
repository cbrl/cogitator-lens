import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const vendorRoot = path.join(process.cwd(), 'src', 'vendor');

async function readVendoredFile(relativePath: string): Promise<string> {
	return fs.readFile(path.join(vendorRoot, relativePath), 'utf8');
}

async function loadCheckVendoredFiles() {
	const module = await import('../scripts/vendor-check.mjs');
	return module.checkVendoredFiles;
}

test('reports only vendored files that differ from upstream', async () => {
	const checkVendoredFiles = await loadCheckVendoredFiles();
	const matching = await checkVendoredFiles('deadbeef', (_revision: string, upstreamPath: string) =>
		readVendoredFile(upstreamPath));
	const mismatching = await checkVendoredFiles('deadbeef', (_revision: string, upstreamPath: string) =>
		upstreamPath === 'lib/parsers/asmregex.ts' ? Promise.resolve('different content') : readVendoredFile(upstreamPath));
	assert.deepEqual(matching, []);
	assert.deepEqual(mismatching, ['lib/parsers/asmregex.ts']);
});
