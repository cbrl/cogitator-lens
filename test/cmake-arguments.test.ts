import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenCmakeArguments } from '../src/buildsystems/cmake-arguments.js';
import {
	getToolchainDefinition,
	supportedToolchainKinds,
} from '../src/toolchains/toolchain-map.js';

test('CMake flattens include paths and definitions after provider arguments', () => {
	for (const kind of supportedToolchainKinds) {
		const definition = getToolchainDefinition(kind);
		assert.deepEqual(
			flattenCmakeArguments(['-O2'], ['include'], ['VALUE=1'], kind),
			[
				'-O2',
				...(definition.includeFlag ? [`${definition.includeFlag}include`] : []),
				...(definition.defineFlag ? [`${definition.defineFlag}VALUE=1`] : []),
			],
			kind,
		);
	}
});
