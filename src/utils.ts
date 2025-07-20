import * as Path from 'path';

export function replaceExtension(filename: string, extension: string): string {
	return Path.join(
		Path.dirname(filename),
		Path.basename(filename, Path.extname(filename)) + extension
	);
}
