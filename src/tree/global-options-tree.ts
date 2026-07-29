import vscode from 'vscode';
import { CompilationService } from '../compilation/index.js';
import type {
	ArtifactOptionId,
	ArtifactOptions,
	ToolchainProfile,
} from '../types/index.js';
import { parseAsmUri } from '../asm-document/asm-uri.js';
import { TreeItem, TreeNode, TreeProvider } from './treedata.js';
import { resolveToolchainCapabilities } from '../toolchains/toolchain-map.js';

interface OptionCapability {
	readonly enabled: boolean;
	readonly explanation?: string;
	readonly description?: string;
}

export class GlobalOptionsNode extends TreeNode {
	static createFilterTree(
		options: ArtifactOptions,
		profile?: ToolchainProfile,
	): GlobalOptionsNode[] {
		const displayDefinitions: Array<{
			label: string;
			id: ArtifactOptionId;
			tooltip: string;
			capability?: OptionCapability;
		}> = [
			{ label: 'Hide unused labels', id: 'labels', tooltip: 'Remove labels that are not referenced' },
			{
				label: 'Hide library code',
				id: 'libraryCode',
				tooltip: 'Hide code from system libraries',
				capability: libraryCodeCapability(profile),
			},
			{ label: 'Hide directives', id: 'directives', tooltip: 'Hide assembler directives' },
			{ label: 'Hide comment-only lines', id: 'commentOnly', tooltip: 'Remove comment-only lines' },
			{ label: 'Trim horizontal whitespace', id: 'trim', tooltip: 'Remove excessive horizontal whitespace' },
			{
				label: 'Show full filenames',
				id: 'dontMaskFilenames',
				tooltip: 'Keep source filenames visible in parsed assembly',
			},
		];
		const outputDefinitions: Array<{
			label: string;
			id: ArtifactOptionId;
			tooltip: string;
			capability: OptionCapability;
		}> = [
			{
				label: 'Intel syntax',
				id: 'intel',
				tooltip: 'Emit Intel syntax when supported by the selected toolchain',
				capability: intelCapability(profile),
			},
			{
				label: 'Demangle symbols',
				id: 'demangle',
				tooltip: 'Run the configured demangler before parsing assembly',
				capability: demangleCapability(profile),
			},
		];

		return [
			{
				label: 'Output Options',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('settings-gear'),
				children: outputDefinitions.map(definition => optionNode(options, definition)),
			},
			{
				label: 'Output Filters',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('filter'),
				children: displayDefinitions.map(definition =>
					definition.capability
						? optionNode(options, {
							...definition,
							capability: definition.capability,
						})
						: {
							label: definition.label,
							nodeType: 'checkbox',
							treeContext: 'filters',
							optionId: definition.id,
							checked: optionValue(options, definition.id),
							tooltip: definition.tooltip,
						}
				),
			},
		];
	}
}

export class GlobalOptionsTreeProvider extends TreeProvider<GlobalOptionsNode> {
	constructor(private readonly compilationService: CompilationService) {
		super();
	}

	getTreeItem(element: GlobalOptionsNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: GlobalOptionsNode): GlobalOptionsNode[] | undefined {
		return element?.children as GlobalOptionsNode[] | undefined
			?? GlobalOptionsNode.createFilterTree(
				this.compilationService.artifactOptions,
				this.selectedToolchainProfile(),
			);
	}

	private selectedToolchainProfile(): ToolchainProfile | undefined {
		let source = vscode.window.activeTextEditor?.document.uri;
		if (source?.scheme === 'assembly') {
			try {
				source = parseAsmUri(source).source;
			} catch {
				source = undefined;
			}
		}
		if (!source || source.scheme !== 'file') {
			source = vscode.window.visibleTextEditors.find(editor =>
				editor.document.uri.scheme === 'file')?.document.uri;
		}
		const variant = source ? this.compilationService.getSelectedVariant(source) : undefined;
		return variant
			? this.compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId)?.profile
			: undefined;
	}
}

function optionNode(
	options: ArtifactOptions,
	definition: {
		label: string;
		id: ArtifactOptionId;
		tooltip: string;
		capability: OptionCapability;
	},
): GlobalOptionsNode {
	return {
		label: definition.label,
		nodeType: 'checkbox',
		treeContext: 'filters',
		optionId: definition.id,
		checked: optionValue(options, definition.id),
		tooltip: definition.capability.explanation ?? definition.tooltip,
		description: definition.capability.description,
		disabled: !definition.capability.enabled,
	};
}

function intelCapability(profile?: ToolchainProfile): OptionCapability {
	if (!profile) {
		return {
			enabled: false,
			description: 'No toolchain selected',
			explanation: 'Open a source file with a compilation variant to configure Intel syntax.',
		};
	}
	const capability = resolveToolchainCapabilities(profile).intelSyntax;
	if (capability === 'inherent') {
		return {
			enabled: false,
			description: 'Inherent',
			explanation: `${profile.displayName} already emits Intel syntax; no output option is required.`,
		};
	}
	return capability === 'selectable'
		? { enabled: true }
		: {
			enabled: false,
			description: 'Unsupported',
			explanation: `${profile.displayName} does not support selectable Intel syntax.`,
		};
}

function demangleCapability(profile?: ToolchainProfile): OptionCapability {
	if (!profile) {
		return {
			enabled: false,
			description: 'No toolchain selected',
			explanation: 'Open a source file with a compilation variant to configure demangling.',
		};
	}
	const capability = resolveToolchainCapabilities(profile).demangle;
	return capability === 'available'
		? { enabled: true }
		: {
			enabled: false,
			description: capability === 'unsupported' ? 'Unsupported' : 'Unavailable',
			explanation: capability === 'unsupported'
				? `${profile.displayName} does not support symbol demangling.`
				: `No demangler was detected or configured for ${profile.displayName}.`,
		};
}

function libraryCodeCapability(profile?: ToolchainProfile): OptionCapability {
	if (!profile) {
		return {
			enabled: false,
			description: 'No toolchain selected',
			explanation: 'Open a source file with a compilation variant to configure library-code filtering.',
		};
	}
	return resolveToolchainCapabilities(profile).libraryCodeFilter === 'available'
		? { enabled: true }
		: {
			enabled: false,
			description: 'Unsupported',
			explanation: `${profile.displayName} does not support library-code filtering.`,
		};
}

function optionValue(options: ArtifactOptions, id: ArtifactOptionId): boolean {
	if (Object.hasOwn(options.production, id)) {
		return options.production[id as keyof ArtifactOptions['production']];
	}
	return options.display[id as keyof ArtifactOptions['display']];
}
