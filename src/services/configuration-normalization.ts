import path from 'path';
import type {
	CompilerKind,
	CompilerProfile,
	CompilerSettings,
	DefaultCompilationSettings,
} from '../types/index.js';

export interface NormalizationResult<T> {
	value?: T;
	errors: readonly string[];
}

const compilerKinds = new Set<CompilerKind>(['gcc', 'clang', 'apple-clang', 'msvc', 'clang-cl']);
const compilerKeys = new Set([
	'name',
	'type',
	'exe',
	'args',
	'includes',
	'defines',
	'env',
	'includeFlag',
	'defineFlag',
	'supportsDemangle',
	'demangler',
	'supportsIntel',
	'supportsLibraryCodeFilter',
]);
const defaultCompilationKeys = new Set([
	'compiler',
	'args',
	'includes',
	'defines',
	'env',
	'workingDirectory',
]);

function stringArray(value: unknown, field: string, errors: string[]): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		errors.push(`${field} must be an array of strings`);
		return [];
	}
	return [...value];
}

function stringRecord(value: unknown, field: string, errors: string[]): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		errors.push(`${field} must be an object containing string values`);
		return {};
	}

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string') {
			errors.push(`${field}.${key} must be a string`);
		} else {
			result[key] = item;
		}
	}
	return result;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			errors.push(`unknown setting: ${key}`);
		}
	}
}

function defaultFlags(kind: CompilerKind): { includeFlag: string; defineFlag: string } {
	return kind === 'msvc' || kind === 'clang-cl'
		? { includeFlag: '/I', defineFlag: '/D' }
		: { includeFlag: '-I', defineFlag: '-D' };
}

export function normalizeCompilerSettings(raw: unknown, origin = 'user'): NormalizationResult<CompilerProfile> {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { errors: ['compiler must be an object'] };
	}

	const value = raw as Record<string, unknown>;
	rejectUnknownKeys(value, compilerKeys, errors);

	const name = typeof value.name === 'string' ? value.name.trim() : '';
	const executable = typeof value.exe === 'string' ? value.exe.trim() : '';
	const kind = value.type;

	if (!name) {
		errors.push('name must be a non-empty string');
	}
	if (!executable) {
		errors.push('exe must be a non-empty string');
	}
	if (typeof kind !== 'string' || !compilerKinds.has(kind as CompilerKind)) {
		errors.push(`type must be one of: ${[...compilerKinds].join(', ')}`);
	}

	const compilerKind = compilerKinds.has(kind as CompilerKind) ? kind as CompilerKind : 'gcc';
	const flags = defaultFlags(compilerKind);
	const normalizedExecutable = executable ? path.normalize(executable) : executable;

	const profile: CompilerProfile = {
		id: origin === 'user'
			? `user:${name}`
			: `${origin}:${process.platform === 'win32' ? normalizedExecutable.toLowerCase() : normalizedExecutable}`,
		displayName: name,
		kind: compilerKind,
		executable: normalizedExecutable,
		defaultArguments: stringArray(value.args, 'args', errors),
		includes: stringArray(value.includes, 'includes', errors),
		defines: stringArray(value.defines, 'defines', errors),
		environment: stringRecord(value.env, 'env', errors),
		includeFlag: typeof value.includeFlag === 'string' ? value.includeFlag : flags.includeFlag,
		defineFlag: typeof value.defineFlag === 'string' ? value.defineFlag : flags.defineFlag,
		demangler: typeof value.demangler === 'string' ? value.demangler : undefined,
		capabilities: {
			demangle: value.supportsDemangle === true,
			intelSyntax: value.supportsIntel === true,
			libraryCodeFilter: value.supportsLibraryCodeFilter === true,
		},
	};

	return { value: errors.length === 0 ? profile : undefined, errors };
}

export function profileToSettings(profile: CompilerProfile): CompilerSettings {
	return {
		name: profile.displayName,
		type: profile.kind,
		exe: profile.executable,
		args: [...profile.defaultArguments],
		includes: [...profile.includes],
		defines: [...profile.defines],
		env: { ...profile.environment },
		includeFlag: profile.includeFlag,
		defineFlag: profile.defineFlag,
		supportsDemangle: profile.capabilities.demangle,
		demangler: profile.demangler,
		supportsIntel: profile.capabilities.intelSyntax,
		supportsLibraryCodeFilter: profile.capabilities.libraryCodeFilter,
	};
}

export function normalizeDefaultCompilationSettings(
	raw: unknown,
): NormalizationResult<DefaultCompilationSettings> {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { errors: ['defaultCompileInfo must be an object'] };
	}

	const value = raw as Record<string, unknown>;
	rejectUnknownKeys(value, defaultCompilationKeys, errors);
	if (typeof value.compiler !== 'string' || value.compiler.trim() === '') {
		errors.push('compiler must be a non-empty string');
	}

	const settings: DefaultCompilationSettings = {
		compiler: typeof value.compiler === 'string' ? value.compiler.trim() : '',
		args: stringArray(value.args, 'args', errors),
		includes: stringArray(value.includes, 'includes', errors),
		defines: stringArray(value.defines, 'defines', errors),
		env: stringRecord(value.env, 'env', errors),
		workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : undefined,
	};

	return { value: errors.length === 0 ? settings : undefined, errors };
}
