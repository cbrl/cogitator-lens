// Verifies the Compiler Explorer sources vendored under src/ and scripts/
// against the pinned upstream revision recorded in src/vendor/VENDOR.md.
//
// Most files are byte-identical. The LLVM IR parser has two explicit `undefined`
// returns added for this project's `noImplicitReturns` setting; that deterministic
// adaptation is applied to upstream before comparison.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..');
const vendorRoot = path.join(repositoryRoot, 'src', 'vendor');
const docenizerRoot = path.join(scriptRoot, 'compiler-explorer-docenizers');
const vendorNoticePath = path.join(vendorRoot, 'VENDOR.md');

function readPinnedRevision() {
	const notice = fs.readFileSync(vendorNoticePath, 'utf8');
	const match = /^Pinned revision: `([0-9a-f]{40})`$/m.exec(notice);
	if (!match) {
		throw new Error(`Could not find a pinned revision in ${vendorNoticePath}`);
	}
	return match[1];
}

// All displayed paths are relative to this repository.
const checkedFiles = [];

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

const assemblyDocumentationFiles = [
	'lib/asm-docs/base.ts',
	'lib/asm-docs/amd64.ts',
	'lib/asm-docs/arm.ts',
	'lib/asm-docs/llvm.ts',
	'lib/asm-docs/python.ts',
	'lib/asm-docs/riscv64.ts',
	'lib/asm-docs/generated/asm-docs-amd64.ts',
	'lib/asm-docs/generated/asm-docs-arm32.ts',
	'lib/asm-docs/generated/asm-docs-aarch64.ts',
	'lib/asm-docs/generated/asm-docs-riscv64.ts',
	'lib/asm-docs/generated/asm-docs-llvm.ts',
	'lib/asm-docs/generated/asm-docs-python.ts',
	'types/assembly-docs.interfaces.ts',
];
for (const upstreamPath of assemblyDocumentationFiles) {
	vendoredFiles[upstreamPath] = upstreamPath;
}

for (const [localRelativePath, upstreamPath] of Object.entries(vendoredFiles)) {
	checkedFiles.push({
		localPath: path.join(vendorRoot, localRelativePath),
		repositoryRelativePath: path.posix.join('src/vendor', localRelativePath),
		upstreamPath,
	});
}

const docenizerFiles = [
	'.gitignore',
	'aarch64.json',
	'arm32.json',
	'docenizer-6502.py',
	'docenizer-amd64.py',
	'docenizer-arm.py',
	'docenizer-avr.py',
	'docenizer-evm.py',
	'docenizer-java.sh',
	'docenizer-java.ts',
	'docenizer-llvm.sh',
	'docenizer-llvm.ts',
	'docenizer-perl.py',
	'docenizer-power.py',
	'docenizer-ptx-sass.py',
	'docenizer-python.py',
	'docenizer-riscv64.py',
	'Makefile',
	'package.json',
	'pyproject.toml',
	'tsconfig.json',
	'uv.lock',
];
for (const name of docenizerFiles) {
	checkedFiles.push({
		localPath: path.join(docenizerRoot, name),
		repositoryRelativePath: path.posix.join('scripts/compiler-explorer-docenizers', name),
		upstreamPath: path.posix.join('etc/scripts/docenizers', name),
	});
}

function expectedLocalContent(upstreamPath, upstreamContent) {
	if (upstreamPath.startsWith('lib/asm-docs/generated/')) {
		return upstreamContent.replace(/\n    \}\n\}\s*$/u, '\n    }\n    return undefined;\n}\n');
	}
	if (upstreamPath !== 'lib/llvm-ir.ts') {
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
	for (const {localPath, repositoryRelativePath, upstreamPath} of checkedFiles) {
		const [localContent, upstreamContent] = await Promise.all([
			fs.promises.readFile(localPath, 'utf8'),
			fetchFile(revision, upstreamPath),
		]);
		if (localContent !== expectedLocalContent(upstreamPath, upstreamContent)) {
			mismatches.push(repositoryRelativePath);
		}
	}
	return mismatches;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// An async IIFE, rather than top-level await, so this module can still be `import`ed
	// (for `checkVendoredFiles`) from a CJS-transpiled context such as a tsx-run test.
	(async () => {
		const revision = readPinnedRevision();
		console.log(`Checking vendored sources against compiler-explorer@${revision}...`);
		try {
			const mismatches = await checkVendoredFiles(revision);
			if (mismatches.length > 0) {
				console.error('The following vendored files differ from their pinned upstream source:');
				for (const file of mismatches) {
					console.error(`  - ${file}`);
				}
				console.error(
					'Follow the re-vendoring procedure in src/vendor/VENDOR.md before changing parser sources.',
				);
				process.exitCode = 1;
			} else {
				console.log('Vendored sources match the pinned upstream revision.');
			}
		} catch (error) {
			console.error(error.message);
			process.exitCode = 1;
		}
	})();
}
