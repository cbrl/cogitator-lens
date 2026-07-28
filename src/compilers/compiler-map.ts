import path from 'path';
import { AppleClangCompiler, ClangCompiler, GccCompiler } from './gcc.js';
import { ClangClCompiler, MsvcCompiler } from './msvc.js';
import type { CompilerKind, CompilerProfile } from '../types/index.js';
import type { CompilerBase } from '../compiler.js';
import { detectCompilerKind } from '../compiler-detection.js';

export interface CompilerAdapter {
	readonly type: CompilerKind;
	new(profile: CompilerProfile): CompilerBase;
	baseCompilerProfile(displayName: string, executable: string): CompilerProfile;
	isCompiler(executable: string): boolean;
}

const adapters: readonly CompilerAdapter[] = [
	GccCompiler,
	ClangClCompiler,
	MsvcCompiler,
	ClangCompiler,
	AppleClangCompiler,
];

export function getCompilerByType(type: string): CompilerAdapter | undefined {
	return adapters.find(adapter => adapter.type === type);
}

export function getCompilerByExe(executable: string, versionOutput?: string): CompilerAdapter | undefined {
	const kind = detectCompilerKind(executable, versionOutput);
	return kind ? getCompilerByType(kind) : undefined;
}

export function normalizedExecutableId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
