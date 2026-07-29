import vscode from 'vscode';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import { CompilationService } from '../compilation/index.js';
import type { CompilerProfile } from '../types/index.js';
import { parseAsmUri } from '../asm-document/asm-uri.js';
import { TreeItem, TreeNode, TreeProvider } from './treedata.js';

interface OptionCapability {
	readonly enabled: boolean;
	readonly explanation?: string;
	readonly description?: string;
}

export class GlobalOptionsNode extends TreeNode {
	static createFilterTree(
		filters: ParseFiltersAndOutputOptions,
		profile?: CompilerProfile,
	): GlobalOptionsNode[] {
		const displayDefinitions: Array<{
			label: string;
			attr: keyof ParseFiltersAndOutputOptions;
			tooltip: string;
		}> = [
			{ label: 'Hide unused labels', attr: 'labels', tooltip: 'Remove labels that are not referenced' },
			{ label: 'Hide library code', attr: 'libraryCode', tooltip: 'Hide code from system libraries' },
			{ label: 'Hide directives', attr: 'directives', tooltip: 'Hide assembler directives' },
			{ label: 'Hide comment-only lines', attr: 'commentOnly', tooltip: 'Remove comment-only lines' },
			{ label: 'Trim horizontal whitespace', attr: 'trim', tooltip: 'Remove excessive horizontal whitespace' },
			{
				label: 'Show full filenames',
				attr: 'dontMaskFilenames',
				tooltip: 'Keep source filenames visible in parsed assembly',
			},
		];
		const outputDefinitions: Array<{
			label: string;
			attr: keyof ParseFiltersAndOutputOptions;
			tooltip: string;
			capability: OptionCapability;
		}> = [
			{
				label: 'Intel syntax',
				attr: 'intel',
				tooltip: 'Emit Intel syntax from GNU-style compilers',
				capability: intelCapability(profile),
			},
			{
				label: 'Demangle symbols',
				attr: 'demangle',
				tooltip: 'Run the configured demangler before parsing assembly',
				capability: demangleCapability(profile),
			},
		];

		return [
			{
				label: 'Output Options',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('settings-gear'),
				children: outputDefinitions.map(definition => optionNode(filters, definition)),
			},
			{
				label: 'Output Filters',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('filter'),
				children: displayDefinitions.map(definition => ({
					label: definition.label,
					nodeType: 'checkbox',
					treeContext: 'filters',
					objectRef: filters,
					attr: definition.attr,
					tooltip: definition.tooltip,
				})),
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
				this.compilationService.globalFilterOptions,
				this.selectedCompilerProfile(),
			);
	}

	private selectedCompilerProfile(): CompilerProfile | undefined {
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
			? this.compilationService.compilerRegistry.getCompilerById(variant.compilerProfileId)?.profile
			: undefined;
	}
}

function optionNode(
	filters: ParseFiltersAndOutputOptions,
	definition: {
		label: string;
		attr: keyof ParseFiltersAndOutputOptions;
		tooltip: string;
		capability: OptionCapability;
	},
): GlobalOptionsNode {
	return {
		label: definition.label,
		nodeType: 'checkbox',
		treeContext: 'filters',
		objectRef: filters,
		attr: definition.attr,
		tooltip: definition.capability.explanation ?? definition.tooltip,
		description: definition.capability.description,
		disabled: !definition.capability.enabled,
	};
}

function intelCapability(profile?: CompilerProfile): OptionCapability {
	if (!profile) {
		return {
			enabled: false,
			description: 'No compiler selected',
			explanation: 'Open a source file with a compilation variant to configure Intel syntax.',
		};
	}
	if (profile.kind === 'msvc' || profile.kind === 'clang-cl') {
		return {
			enabled: false,
			description: 'Inherent',
			explanation: `${profile.displayName} already emits Intel syntax; no output option is required.`,
		};
	}
	return profile.capabilities.intelSyntax
		? { enabled: true }
		: {
			enabled: false,
			description: 'Unsupported',
			explanation: `${profile.displayName} does not support selectable Intel syntax.`,
		};
}

function demangleCapability(profile?: CompilerProfile): OptionCapability {
	if (!profile) {
		return {
			enabled: false,
			description: 'No compiler selected',
			explanation: 'Open a source file with a compilation variant to configure demangling.',
		};
	}
	return profile.capabilities.demangle && profile.demangler
		? { enabled: true }
		: {
			enabled: false,
			description: 'Unavailable',
			explanation: `No demangler was detected or configured for ${profile.displayName}.`,
		};
}
