/** Manifest metadata for editor languages owned by generated artifacts. */
export const artifactEditorLanguages = {
	'coglens-asm': {
		aliases: ['Compiler Assembly'],
		grammar: { scopeName: 'source.coglens-asm', path: './syntaxes/coglens-asm.tmLanguage.json' },
	},
	'coglens-llvm-ir': {
		aliases: ['LLVM IR'],
		grammar: { scopeName: 'source.coglens-llvm-ir', path: './syntaxes/coglens-llvm-ir.tmLanguage.json' },
	},
	'coglens-ast': {
		aliases: ['Compiler AST'],
		grammar: { scopeName: 'source.coglens-ast', path: './syntaxes/coglens-ast.tmLanguage.json' },
	},
	'coglens-mir': {
		aliases: ['Rust MIR'],
		grammar: { scopeName: 'source.coglens-mir', path: './syntaxes/coglens-mir.tmLanguage.json' },
	},
} as const;

export type ArtifactEditorLanguageId = keyof typeof artifactEditorLanguages;
