import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
	stylistic.configs.recommended,
	{
		files: ['**/*.ts'],
	},
	{
		ignores: [
			'node_modules/',
			'src/vendor/lib/llvm-ir.ts',
			'src/vendor/lib/asm-docs/**/*',
			'src/vendor/lib/parsers/**/*',
			'src/vendor/static/**/*',
			'src/vendor/types/**/*',
			'scripts/compiler-explorer-docenizers/',
		],
	},
	eslintConfigPrettier,
	{
		plugins: {
			'@stylistic': stylistic,
			'@typescript-eslint': typescriptEslint,
		},

		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2022,
			sourceType: 'module',
		},

		rules: {
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					selector: 'import',
					format: ['camelCase', 'PascalCase'],
				},
			],

			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			'@stylistic/quotes': ['warn', 'single', { allowTemplateLiterals: 'always', avoidEscape: true }],
		},
	},
];
