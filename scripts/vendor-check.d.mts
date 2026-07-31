export function checkVendoredFiles(
	revision: string,
	fetchFile?: (revision: string, upstreamPath: string) => Promise<string>,
): Promise<string[]>;
