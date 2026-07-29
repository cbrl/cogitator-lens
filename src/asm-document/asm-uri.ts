import { Uri } from 'vscode';
import type {
	CompilationOutputMode,
	CompilationVariant,
} from '../types/index.js';
import { replaceExtension } from '../utils.js';

export const assemblyScheme = 'assembly';

export interface AssemblyUriIdentity {
	source: Uri;
	variantId: string;
	outputMode: CompilationOutputMode;
}

export function getAsmUri(
	source: Uri,
	variant: Pick<CompilationVariant, 'id' | 'displayLabel'>,
	outputMode: CompilationOutputMode = 'assembly',
): Uri {
	const query = new URLSearchParams({
		source: source.toString(),
		variant: variant.id,
		mode: outputMode,
	});
	const label = readablePathLabel(variant.displayLabel);
	return source.with({
		scheme: assemblyScheme,
		path: replaceExtension(source.path, ` [${label}].asm`),
		query: query.toString(),
		fragment: '',
	});
}

export function parseAsmUri(uri: Uri): AssemblyUriIdentity {
	if (uri.scheme !== assemblyScheme) {
		throw new Error(`Expected an ${assemblyScheme}: URI, received ${uri.scheme}:`);
	}
	const query = new URLSearchParams(uri.query);
	const source = query.get('source');
	const variantId = query.get('variant');
	const outputMode = query.get('mode');
	if (!source || !variantId || outputMode !== 'assembly') {
		throw new Error(`Invalid assembly document URI: ${uri.toString()}`);
	}
	return {
		source: Uri.parse(source),
		variantId,
		outputMode,
	};
}

function readablePathLabel(label: string): string {
	const readable = label
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim();
	return (readable || 'variant').slice(0, 80);
}
