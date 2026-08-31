/** @type {import("prettier").Config} */
export default {
	endOfLine: 'lf',
	printWidth: 120,
	semi: true,
	tabWidth: 4,
	useTabs: true,
	singleQuote: true,
	trailingComma: 'all',
	arrowParens: 'always',
	bracketSpacing: true,
	overrides: [
		{
			files: ['*.json', '*.yaml', '*.yml'],
			options: {
				tabWidth: 2,
				useTabs: false,
			},
		},
	],
};
