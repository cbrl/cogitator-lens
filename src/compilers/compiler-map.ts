import * as allCompilers from './all';
import { keyToTypeMap } from '../utils';

const compilerMap = keyToTypeMap(allCompilers, 'type');

export function getCompilerByType(type: string): typeof compilerMap[keyof typeof compilerMap] | undefined {
	if (type in compilerMap) {
		return compilerMap[type];
	}

	return undefined;
}

export function getCompilerByExe(exe: string): typeof compilerMap[keyof typeof compilerMap] | undefined {
	for (const compiler of Object.values(allCompilers)) {

		if (compiler.isCompiler(exe)) {
			return compiler;
		}
	}

	return undefined;
}
