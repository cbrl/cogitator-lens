import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import {
	ToolExitError,
} from '../../toolchains/toolchain-backend.js';
import {
	UnsupportedToolVersionError,
} from '../../types/index.js';

const pythonVersionMarker = 'COGLENS_UNSUPPORTED_PYTHON_VERSION:';

const pythonAstHelper = [
	'import ast,sys,tokenize',
	`sys.version_info < (3,9) and sys.exit("${pythonVersionMarker}"+".".join(map(str,sys.version_info[:3])))`,
	'filename=sys.argv[1]',
	'f=tokenize.open(filename)',
	'source=f.read()',
	'f.close()',
	'tree=ast.parse(source,filename=filename)',
	'print(ast.dump(tree,indent=2,include_attributes=True))',
].join(';');

export const pythonAstProducer: ArtifactProducer = async (
	backend,
	source,
	options,
	cancellationToken,
) => {
	try {
		return await backend.produceArtifact(
			'ast',
			source,
			options,
			{
				output: 'stdout',
				arguments: () => ['-I', '-c', pythonAstHelper],
			},
			cancellationToken,
		);
	} catch (error) {
		if (error instanceof ToolExitError) {
			const match = new RegExp(`${pythonVersionMarker}([0-9.]+)`).exec(error.stderr);
			if (match) {
				throw new UnsupportedToolVersionError(
					`Python AST requires Python 3.9 or later; the selected interpreter is ${match[1]}.`,
					match[1],
					'3.9',
					{ cause: error },
				);
			}
		}
		throw error;
	}
};

export { pythonAstHelper };
