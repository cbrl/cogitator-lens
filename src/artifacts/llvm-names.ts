/**
 * LLVM identifier decoding shared by the LLVM IR text renderer and the LLVM
 * control-flow-graph parser.
 *
 * LLVM quotes any identifier that is not a plain word and escapes bytes inside
 * it as `\xx`, so both consumers need the same unescaping to recover the
 * function and block names the user sees.
 */

/** Decodes an LLVM string body, resolving `\xx` byte escapes. */
export function decodeLlvmString(value: string): string {
	return value
		.replace(/\\([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\"/gu, '"')
		.replace(/\\\\/gu, '\\');
}

/** Decodes an LLVM identifier, removing surrounding quotes when present. */
export function decodeLlvmName(value: string): string {
	const unquoted = value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1)
		: value;
	return decodeLlvmString(unquoted);
}
