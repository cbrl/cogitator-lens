import path from 'path';
import { AppleClangCompiler, ClangCompiler, GccCompiler } from './gcc.js';
import { ClangClCompiler, MsvcCompiler } from './msvc.js';
import type { CompilerKind, CompilerProfile } from '../types/index.js';
import type { CompilerBase } from '../compiler.js';

export interface CompilerAdapter {
	readonly type: CompilerKind;
	new(profile: CompilerProfile): CompilerBase;
	baseCompilerProfile(displayName: string, executable: string): CompilerProfile;
	isCompiler(executable: string): boolean;
}

export const compilerAdapters: readonly CompilerAdapter[] = [
	GccCompiler,
	ClangClCompiler,
	MsvcCompiler,
	ClangCompiler,
	AppleClangCompiler,
];

export function getCompilerByType(type: string): CompilerAdapter | undefined {
	return compilerAdapters.find(adapter => adapter.type === type);
}

export function getCompilerByExe(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): CompilerAdapter | undefined {
	const matches = compilerAdapters.filter(adapter => adapter.isCompiler(executable));
	if (matches.some(adapter => adapter.type === 'apple-clang')) {
		const clangType: CompilerKind = /apple clang/i.test(versionOutput) || platform === 'darwin'
			? 'apple-clang'
			: 'clang';
		return matches.find(adapter => adapter.type === clangType);
	}
	return matches[0];
}

export const supportedCompilerKinds: readonly CompilerKind[] =
	compilerAdapters.map(adapter => adapter.type);

export function normalizedExecutableId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
