export const supportedToolchainKinds = [
	'gcc',
	'clang-cl',
	'msvc',
	'clang',
	'apple-clang',
	'rust',
	'cargo',
	'python',
	'dotnet',
	'java',
	'go',
	'zig',
	'nvcc',
] as const;

export type RegisteredToolchainKind = (typeof supportedToolchainKinds)[number];
