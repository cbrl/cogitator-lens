import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../exec.js';
import { isRecord } from '../common.js';
import type { ToolchainProfile } from '../types/index.js';
import { createToolchainProfile } from './toolchain-map.js';
import { targetFromClangBanner } from './target-architecture.js';
import { environmentValue, versionBanner } from './version-banner.js';

/** A Visual Studio install that vswhere reports. */
export interface VisualStudioInstall {
	readonly instanceId: string;
	readonly installationPath: string;
	/** The product name, such as "Visual Studio Community 2026 Insiders". */
	readonly displayName: string;
}

/**
 * Lists the complete installs of each product, also prerelease ones. An install without the C++
 * tools has no `VC\Tools` folder, so detection skips it.
 */
export const visualStudioListArguments = Object.freeze(['-products', '*', '-prerelease', '-format', 'json', '-utf8']);

/** Reads the installs from the JSON output of vswhere. */
export function parseVisualStudioInstalls(text: string): VisualStudioInstall[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap((entry): VisualStudioInstall[] => {
		if (!isRecord(entry) || typeof entry.installationPath !== 'string' || typeof entry.instanceId !== 'string') {
			return [];
		}
		const name =
			typeof entry.displayName === 'string' ? entry.displayName : path.win32.basename(entry.installationPath);
		const catalog: Record<string, unknown> = isRecord(entry.catalog) ? entry.catalog : {};
		// A prerelease has the same product name as the release of its year.
		const milestone =
			entry.isPrerelease === true && typeof catalog.productMilestone === 'string'
				? ` ${catalog.productMilestone}`
				: '';
		return [
			{ instanceId: entry.instanceId, installationPath: entry.installationPath, displayName: name + milestone },
		];
	});
}

/**
 * The folders of the compilers that run on the host and build for it: below `VC\Tools\MSVC\<toolset>\bin`
 * for cl.exe, and below `VC\Tools\Llvm` for clang-cl.
 */
export function hostCompilerFolders(
	architecture: string,
): { readonly msvc: readonly string[]; readonly llvm: readonly string[] } | undefined {
	switch (architecture) {
		case 'x64':
			return { msvc: ['Hostx64', 'x64'], llvm: ['x64', 'bin'] };
		case 'arm64':
			return { msvc: ['HostArm64', 'arm64'], llvm: ['ARM64', 'bin'] };
		case 'ia32':
			return { msvc: ['Hostx86', 'x86'], llvm: ['bin'] };
		default:
			return undefined;
	}
}

/**
 * Finds cl.exe and clang-cl in each Visual Studio install that vswhere reports. Each MSVC toolset
 * gives a profile, newest first, and the path of its compiler selects its headers and libraries.
 */
export async function detectVisualStudioToolchains(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	architecture: string = os.arch(),
): Promise<ToolchainProfile[]> {
	const folders = hostCompilerFolders(architecture);
	const programFiles = environmentValue(environment, 'ProgramFiles(x86)', 'win32');
	if (platform !== 'win32' || !folders || !programFiles) {
		return [];
	}
	const vswhere = path.win32.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
	if (!fs.existsSync(vswhere)) {
		return [];
	}
	let output: string;
	try {
		const result = await execute(vswhere, visualStudioListArguments, {
			env: environment,
			timeoutMs: 10_000,
			maxOutputBytes: 1024 * 1024,
		});
		if (result.returnCode !== 0) {
			return [];
		}
		output = result.stdout;
	} catch {
		return [];
	}
	const installs = parseVisualStudioInstalls(output);
	return (await Promise.all(installs.map((install) => installToolchains(install, folders, environment)))).flat();
}

async function installToolchains(
	install: VisualStudioInstall,
	folders: NonNullable<ReturnType<typeof hostCompilerFolders>>,
	environment: NodeJS.ProcessEnv,
): Promise<ToolchainProfile[]> {
	const toolsFolder = path.join(install.installationPath, 'VC', 'Tools');
	const msvcFolder = path.join(toolsFolder, 'MSVC');
	let toolsets: string[] = [];
	try {
		toolsets = (await fs.promises.readdir(msvcFolder)).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
	} catch {
		// An install without the C++ tools.
	}
	toolsets.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
	const msvc = toolsets.flatMap((toolset) => {
		const executable = path.join(msvcFolder, toolset, 'bin', ...folders.msvc, 'cl.exe');
		return fs.existsSync(executable)
			? [
					createToolchainProfile('msvc', `MSVC ${toolset}`, executable, {
						id: `msvc@${install.instanceId}@${toolset}`,
						detectedIn: install.displayName,
					}),
				]
			: [];
	});
	const clangCl = path.join(toolsFolder, 'Llvm', ...folders.llvm, 'clang-cl.exe');
	const clangBanner = fs.existsSync(clangCl) ? await versionBanner(clangCl, ['--version'], environment) : undefined;
	const clang = clangBanner
		? [
				createToolchainProfile(
					'clang-cl',
					`clang-cl ${/clang version (\d+\.\d+(?:\.\d+)?)/.exec(clangBanner)?.[1] ?? 'unknown'}`,
					clangCl,
					{
						id: `clang-cl@${install.instanceId}`,
						detectedIn: install.displayName,
						target: targetFromClangBanner(clangBanner),
					},
				),
			]
		: [];
	return [...msvc, ...clang];
}
