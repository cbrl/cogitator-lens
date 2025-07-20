import * as Path from 'path';

export function replaceExtension(filename: string, extension: string): string {
	return Path.join(
		Path.dirname(filename),
		Path.basename(filename, Path.extname(filename)) + extension
	);
}

/**
 * Given a record of objects where each object has a given key, create a mapping of the key
 * values to their corresponding objects.
 *
 * @param objects A record of objects where each object has the specified key
 * @param key The key to map
 *
 * @returns A record mapping the key values to their corresponding objects
 */
export function keyToTypeMap<K extends keyof any, T extends Record<K, string>>(objects: Record<string, T>, key: K): Record<string, T> {
	const keyToType: Record<string, T> = {};
	const keyToName: Record<string, string> = {};

	for (const objectName in objects) {
		const type = objects[objectName];

		if (type[key] === undefined) {
			throw new Error(`${objectName}.${String(key)} does not exist`);
		}
		else if (type[key]) {
			if (keyToType[type[key]] === undefined) {
				keyToType[type[key]] = type;
				keyToName[type[key]] = objectName;
			}
			else {
				throw new Error(`Value of ${objectName}.${String(key)} is the same as ${keyToName[type[key]]}.${String(key)}`);
			}
		}
		else {
			throw new Error(`Value of ${objectName}.${String(key)} is empty`);
		}
	}

	return keyToType;
}
