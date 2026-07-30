// Local shim for Compiler Explorer's lib/utils.js, providing only the functions the
// vendored parsers import. Implementations are copied from upstream so parsing behaviour
// matches exactly; the surrounding file (compiler-server config loading, golden-layout
// helpers, etc.) does not apply to this extension.

const tabsRe = /\t/g;
const lineRe = /\r?\n/;

export function splitLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const result = text.split(lineRe);
	if (result.length > 0 && result[result.length - 1] === '') {
		return result.slice(0, -1);
	}
	return result;
}

export function eachLine(text: string, func: (line: string) => void): void {
	for (const line of splitLines(text)) {
		func(line);
	}
}

export function expandTabs(line: string): string {
	let extraChars = 0;
	return line.replaceAll(tabsRe, (match, offset) => {
		const total = offset + extraChars;
		const spacesNeeded = (total + 8) & 7;
		extraChars += spacesNeeded - 1;
		return '        '.substring(spacesNeeded);
	});
}

export function squashHorizontalWhitespace(line: string, atStart = true): string {
	if (line.trim().length === 0) {
		return '';
	}
	const splat = line.split(/\s+/);
	if (splat[0] === '' && atStart) {
		// An indented line: preserve a two-space indent (max)
		const indent = line[1] === ' ' ? '  ' : ' ';
		return indent + splat.slice(1).join(' ');
	}
	return splat.join(' ');
}

export function deltaTimeNanoToMili(startTime: bigint, endTime: bigint): number {
	return Number((endTime - startTime) / BigInt(1_000_000));
}

// Matches everything up to and through a CE-style temp dir, `.../<ce_temp_prefix><suffix>/`.
// This extension never names its own temp directories with this marker (see
// withTemporaryDirectory's `coglens-` prefix), so this is a no-op for every real path the
// parsers see here; it is kept so `maskRootdir` behaves identically to upstream instead of
// being deleted and re-derived.
export const ce_temp_prefix = 'compiler-explorer-compiler';
const TEMPDIR_RE = new RegExp(`(?:[A-Za-z]:)?/(?:[^/\\s]+/)*${ce_temp_prefix}[\\w.-]*/`);

export function maskRootdir(filepath: string): string {
	if (!filepath) {
		return filepath;
	}
	const masked = filepath.includes(ce_temp_prefix) ? filepath.replace(TEMPDIR_RE, '/app/') : filepath;
	return masked.replace(/^\/app\//, '');
}
