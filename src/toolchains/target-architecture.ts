import os from 'node:os';
import { execute } from '../exec.js';
import { localFileComparisonKey } from '../file-identity.js';
import type { TargetArchitecture, ToolchainProfile } from '../types/index.js';

/** The instruction set of a target triple, such as `aarch64-linux-gnu`. */
export function architectureOfTriple(triple: string | undefined): TargetArchitecture | undefined {
	const architecture = triple?.trim().toLowerCase().split('-')[0];
	if (!architecture) {
		return undefined;
	}
	if (/^(?:x86_64h?|amd64|x64|i[3-6]86|x86)$/.test(architecture)) {
		return 'x86';
	}
	if (/^(?:aarch64(?:_be|_32)?|arm64(?:e|ec|_32)?)$/.test(architecture)) {
		return 'aarch64';
	}
	if (/^(?:arm|armeb|armv\d.*|thumb.*)$/.test(architecture)) {
		return 'arm32';
	}
	if (/^riscv64/.test(architecture)) {
		return 'riscv64';
	}
	if (/^(?:powerpc|ppc)/.test(architecture)) {
		return 'power';
	}
	if (/^nvptx/.test(architecture)) {
		return 'ptx';
	}
	return undefined;
}

/**
 * The target that compiler arguments select: `--target=<triple>`, `-target <triple>`, or
 * `--target <triple>` for Clang, rustc, and Zig, also in the `/clang:` form of clang-cl, and
 * `-arch <name>` for Apple Clang. The last one applies.
 */
export function targetFromArguments(args: readonly string[]): string | undefined {
	let target: string | undefined;
	args.forEach((argument, index) => {
		const joined = /^(?:\/clang:)?--?target=(.+)$/.exec(argument)?.[1];
		const separate =
			(argument === '-target' || argument === '--target') && index + 1 < args.length
				? args[index + 1]
				: undefined;
		const appleArchitecture = argument === '-arch' && index + 1 < args.length ? args[index + 1] : undefined;
		target = joined ?? separate ?? (appleArchitecture ? `${appleArchitecture}-apple-darwin` : target);
	});
	return target;
}

/** The target triple of a Visual Studio compiler, from the target folder of its path. */
export function msvcTarget(executable: string, hostArchitecture: string = os.arch()): string {
	const folder = /[\\/]Host[^\\/]+[\\/]([^\\/]+)[\\/]cl\.exe$/i.exec(executable)?.[1]?.toLowerCase();
	const architecture = folder ?? (hostArchitecture === 'ia32' ? 'x86' : hostArchitecture);
	const triples: Readonly<Record<string, string>> = {
		x64: 'x86_64-pc-windows-msvc',
		x86: 'i686-pc-windows-msvc',
		arm64: 'aarch64-pc-windows-msvc',
		arm: 'armv7-pc-windows-msvc',
	};
	return triples[architecture] ?? `${architecture}-pc-windows-msvc`;
}

/** The target line of a Clang version banner. */
export function targetFromClangBanner(banner: string): string | undefined {
	return /^Target:\s*(\S+)/m.exec(banner)?.[1];
}

const detectedTargets = new Map<string, Promise<string | undefined>>();

/**
 * The default target of a toolchain: the target of its profile, or the target that the compiler
 * reports. The report runs once for each compiler: `-dumpmachine` for GCC and Clang, `--version` for
 * clang-cl, and `-vV` for rustc. The path of cl.exe names its target.
 */
export function toolchainTarget(profile: ToolchainProfile): Promise<string | undefined> {
	if (profile.target) {
		return Promise.resolve(profile.target);
	}
	if (profile.kind === 'msvc') {
		return Promise.resolve(msvcTarget(profile.executable));
	}
	const query = targetQueries[profile.kind];
	if (!query) {
		return Promise.resolve(undefined);
	}
	const key = `${profile.kind}\0${localFileComparisonKey(profile.executable)}`;
	let target = detectedTargets.get(key);
	if (!target) {
		target = execute(profile.executable, query.arguments, {
			cwd: os.tmpdir(),
			env: { ...process.env, ...profile.environment },
			timeoutMs: 10_000,
			maxOutputBytes: 64 * 1024,
		}).then(
			(result) => (result.returnCode === 0 ? query.read(result.stdout) : undefined),
			() => undefined,
		);
		detectedTargets.set(key, target);
	}
	return target;
}

const targetQueries: Partial<
	Record<
		ToolchainProfile['kind'],
		{ readonly arguments: readonly string[]; read(output: string): string | undefined }
	>
> = {
	gcc: { arguments: ['-dumpmachine'], read: (output) => output.trim() || undefined },
	clang: { arguments: ['-dumpmachine'], read: (output) => output.trim() || undefined },
	'apple-clang': { arguments: ['-dumpmachine'], read: (output) => output.trim() || undefined },
	'clang-cl': { arguments: ['--version'], read: targetFromClangBanner },
	rust: { arguments: ['-vV'], read: (output) => /^host:\s*(\S+)/m.exec(output)?.[1] },
};
