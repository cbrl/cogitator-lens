import os from 'node:os';
import path from 'node:path';

/** What the variables in a setting refer to. */
export interface PathContext {
	/** The open workspace folders. */
	readonly folders: readonly { readonly name: string; readonly path: string }[];
	/** The folder that `${workspaceFolder}` and relative paths refer to. */
	readonly defaultFolder?: string;
	readonly userHome: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

/** A context without workspace folders, so only `${userHome}` and `${env:NAME}` expand. */
export const noWorkspaceContext: PathContext = Object.freeze({
	folders: [],
	userHome: os.homedir(),
	environment: process.env,
});

const variable = /\$\{(?:workspaceFolder(?::([^}]+))?|(userHome)|env:([^}]+))\}/g;

/**
 * Expands `${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}`, and `${env:NAME}`, as
 * VS Code tasks do. A folder variable that names no open folder is kept, so the path shows why
 * it does not exist.
 */
export function expandVariables(value: string, context: PathContext): string {
	return value.replace(
		variable,
		(match, folderName: string | undefined, userHome: string | undefined, environmentName: string | undefined) => {
			if (userHome) {
				return context.userHome;
			}
			if (environmentName !== undefined) {
				return context.environment[environmentName] ?? '';
			}
			const folder =
				folderName === undefined
					? context.defaultFolder
					: context.folders.find((candidate) => candidate.name === folderName)?.path;
			return folder ?? match;
		},
	);
}

/** Expands a path setting and resolves a relative result against the default folder. */
export function resolvePathSetting(value: string, context: PathContext): string {
	const expanded = expandVariables(value, context);
	if (!expanded) {
		return expanded;
	}
	return path.normalize(
		path.isAbsolute(expanded) || !context.defaultFolder ? expanded : path.resolve(context.defaultFolder, expanded),
	);
}

/**
 * Spells an absolute path for a shared settings file: relative to `${workspaceFolder}`, or to
 * `${workspaceFolder:name}` for another folder, with forward slashes. A path outside every
 * folder, or one that is not absolute, is kept.
 */
export function portablePath(absolutePath: string, context: PathContext): string {
	if (!path.isAbsolute(absolutePath)) {
		return absolutePath;
	}
	const folders = [
		...context.folders
			.filter((folder) => folder.path === context.defaultFolder)
			.map((folder) => ({ ...folder, primary: true })),
		...context.folders
			.filter((folder) => folder.path !== context.defaultFolder)
			.map((folder) => ({ ...folder, primary: false })),
	];
	for (const folder of folders) {
		const relative = path.relative(folder.path, absolutePath);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			continue;
		}
		const prefix = folder.primary ? '${workspaceFolder}' : `\${workspaceFolder:${folder.name}}`;
		return relative ? `${prefix}/${relative.split(path.sep).join('/')}` : prefix;
	}
	return absolutePath;
}
