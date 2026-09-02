export const supportedToolchainKinds = [
	'gcc',
	'clang-cl',
	'msvc',
	'clang',
	'apple-clang',
	'rust',
	'python',
	'dotnet',
	'go',
	'zig',
	'nvcc',
] as const;

export type RegisteredToolchainKind = (typeof supportedToolchainKinds)[number];
