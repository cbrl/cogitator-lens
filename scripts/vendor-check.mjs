// Verifies src/vendor/'s Compiler Explorer parser sources against the pinned
// upstream revision recorded in src/vendor/VENDOR.md.
//
// Most files are byte-identical. The LLVM IR parser has two explicit `undefined`
// returns added for this project's `noImplicitReturns` setting; that deterministic
// adaptation is applied to upstream before comparison.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(repositoryRoot, 'src', 'vendor');
const vendorNoticePath = path.join(vendorRoot, 'VENDOR.md');

function readPinnedRevision() {
	const notice = fs.readFileSync(vendorNoticePath, 'utf8');
	const match = /^Pinned revision: `([0-9a-f]{40})`$/m.exec(notice);
	if (!match) {
		throw new Error(`Could not find a pinned revision in ${vendorNoticePath}`);
	}
	return match[1];
}

// Local vendor path (relative to src/vendor/) -> upstream path (relative to the
// compiler-explorer repository root).
const vendoredFiles = {
	'lib/llvm-ir.ts': 'lib/llvm-ir.ts',
	'lib/parsers/asm-parser.ts': 'lib/parsers/asm-parser.ts',
	'lib/parsers/asm-parser-vc.ts': 'lib/parsers/asm-parser-vc.ts',
	'lib/parsers/asm-parser.interfaces.ts': 'lib/parsers/asm-parser.interfaces.ts',
	'lib/parsers/asmregex.ts': 'lib/parsers/asmregex.ts',
	'lib/parsers/label-processor.ts': 'lib/parsers/label-processor.ts',
	'lib/parsers/parsing-state.ts': 'lib/parsers/parsing-state.ts',
	'lib/parsers/source-line-handler.ts': 'lib/parsers/source-line-handler.ts',
	'lib/properties.interfaces.ts': 'lib/properties.interfaces.ts',
	'static/panes/opt-view.interfaces.ts': 'static/panes/opt-view.interfaces.ts',
	'types/asmresult/asmresult.interfaces.ts': 'types/asmresult/asmresult.interfaces.ts',
	'types/compilation/ir.interfaces.ts': 'types/compilation/ir.interfaces.ts',
	'types/features/filters.interfaces.ts': 'types/features/filters.interfaces.ts',
};

function expectedLocalContent(localRelativePath, upstreamContent) {
	if (localRelativePath !== 'lib/llvm-ir.ts') {
		return upstreamContent;
	}
	return upstreamContent
		.replace(
			`        if (!debugInfo[scope]) {\n            return;\n        }\n`,
			`        if (!debugInfo[scope]) {\n            return undefined;\n        }\n`,
		)
		.replace(
			`        if (debugInfo[scope].scope) {\n` +
				`            return this.getSourceColumn(debugInfo, debugInfo[scope].scope!);\n` +
				`        }\n    }\n\n    parseMetaNode`,
			`        if (debugInfo[scope].scope) {\n` +
				`            return this.getSourceColumn(debugInfo, debugInfo[scope].scope!);\n` +
				`        }\n        return undefined;\n    }\n\n    parseMetaNode`,
		);
}

async function fetchUpstream(revision, upstreamPath) {
	const url = `https://raw.githubusercontent.com/compiler-explorer/compiler-explorer/${revision}/${upstreamPath}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

export async function checkVendoredFiles(revision, fetchFile = fetchUpstream) {
	const mismatches = [];
	for (const [localRelativePath, upstreamPath] of Object.entries(vendoredFiles)) {
		const localPath = path.join(vendorRoot, localRelativePath);
		const [localContent, upstreamContent] = await Promise.all([
			fs.promises.readFile(localPath, 'utf8'),
			fetchFile(revision, upstreamPath),
		]);
		if (localContent !== expectedLocalContent(localRelativePath, upstreamContent)) {
			mismatches.push(localRelativePath);
		}
	}
	return mismatches;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// An async IIFE, rather than top-level await, so this module can still be `import`ed
	// (for `checkVendoredFiles`) from a CJS-transpiled context such as a tsx-run test.
	(async () => {
		const revision = readPinnedRevision();
		console.log(`Checking src/vendor/ against compiler-explorer@${revision}...`);
		try {
			const mismatches = await checkVendoredFiles(revision);
			if (mismatches.length > 0) {
				console.error('The following vendored files differ from their pinned upstream source:');
				for (const file of mismatches) {
					console.error(`  - src/vendor/${file}`);
				}
				console.error(
					'Follow the re-vendoring procedure in src/vendor/VENDOR.md before changing parser sources.',
				);
				process.exitCode = 1;
			} else {
				console.log('src/vendor/ matches the pinned upstream revision.');
			}
		} catch (error) {
			console.error(error.message);
			process.exitCode = 1;
		}
	})();
}
