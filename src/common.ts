/**
 * Small helpers shared by the extension host and the webview bundle.
 *
 * This module must not import anything, so the webview can bundle it.
 */

/** Splits tool output on any line ending without producing a trailing empty line. */
export function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/u);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
