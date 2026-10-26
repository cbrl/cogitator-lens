import { sameLocalFileTest } from '../../file-identity.js';
import type { MainSource } from '../assembly/main-source.js';

/** A function header in objdump-style output, as the vendored parser reads it. */
const functionHeader = /^[\da-f]+\s+<.+>:$/;
/** A line-number marker after normalization, where GNU objdump may add a discriminator. */
const lineMarker = /^((?:[A-Za-z]:)?\/.*?):\d+(?: \(discriminator \d+\))?\s*$/;

/**
 * Removes the disassembled functions whose line information never names the compiled file, such
 * as template instantiations from headers. The vendored parser marks every line with line
 * information as the main source, so its own library filter keeps them. Functions without line
 * information are kept.
 */
export function withoutLibraryFunctions(rawDisassembly: string, mainSource: MainSource): string {
	const isMainSource = sameLocalFileTest(mainSource.path, mainSource.workingDirectory);
	const kept: string[] = [];
	let chunk: string[] = [];
	let sawSource = false;
	let sawMainSource = false;
	const flush = (): void => {
		if (!sawSource || sawMainSource) {
			kept.push(...chunk);
		}
		chunk = [];
		sawSource = false;
		sawMainSource = false;
	};
	for (const line of rawDisassembly.split('\n')) {
		if (functionHeader.test(line.trimEnd())) {
			flush();
		}
		const marker = lineMarker.exec(line);
		if (marker) {
			sawSource = true;
			sawMainSource ||= isMainSource(marker[1]);
		}
		chunk.push(line);
	}
	flush();
	return kept.join('\n');
}
