import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildArtifactDetails,
	invocationDetails,
	type ArtifactDetailsItem,
} from '../src/artifacts/ui/artifact-details.js';
import type { ArtifactDocumentSnapshot } from '../src/artifact-document/artifact-identity.js';
import type { ArtifactStatus } from '../src/artifact-document/artifact-generator.js';
import type { ArtifactCommand, RawArtifact, RenderedArtifact } from '../src/types/index.js';

test('invocation details redact values at the presentation boundary', () => {
	const secret = 'do-not-display-this-value';
	const command = {
		executable: '/tool chain/clang++',
		arguments: ['-O2', '-DNAME=value with spaces'],
		environmentVariableNames: ['TOKEN', 'API_KEY'],
		workingDirectory: '/project',
		environment: { TOKEN: secret },
	} satisfies ArtifactCommand & { environment: Record<string, string> };
	const details = invocationDetails(command);
	assert.deepEqual(details, {
		executable: '/tool chain/clang++',
		args: ['-O2', '-DNAME=value with spaces'],
		cwd: '/project',
		environmentVariableNames: ['API_KEY', 'TOKEN'],
	});
	assert.doesNotMatch(JSON.stringify(details), new RegExp(secret));
	assert.equal(Object.hasOwn(details, 'environment'), false);
});

test('artifact details expose deterministic identity, status, invocation, environment, and metric groups', () => {
	const details = buildArtifactDetails(snapshot(successfulStatus()), {
		largestFrame: 'Largest known frame',
	});
	assert.deepEqual(
		details.map((item) => item.label),
		['Artifact', 'Status', 'Invocation', 'Environment', 'Metrics'],
	);
	assert.equal(itemValue(details, 'state'), 'Ready with diagnostics');
	assert.equal(itemValue(details, 'errors'), '1');
	assert.equal(itemValue(details, 'warnings'), '1');
	assert.equal(itemValue(details, 'information'), '1');
	assert.equal(itemValue(details, 'duration'), '12 ms');
	assert.equal(itemValue(details, 'generated'), '2023-11-14T22:13:20.000Z');
	assert.equal(itemValue(details, 'command-line'), '"/tool chain/clang++" -O2 "-DNAME=value with spaces"');
	const environment = findItem(details, 'environment').children ?? [];
	assert.deepEqual(
		environment.map((item) => item.label),
		['API_KEY', 'TOKEN'],
	);
	const metrics = findItem(details, 'metrics').children ?? [];
	assert.deepEqual(
		metrics.map((item) => item.id),
		['metric-functionCount', 'metric-largestFrame'],
	);
	assert.equal(metrics[1].label, 'Largest known frame');
	assert.equal(metrics[1].copyText, '64');
});

test('artifact details represent all lifecycle states without requiring an artifact', () => {
	const statuses: Array<[ArtifactStatus, string]> = [
		[{ state: 'stale', truncated: false }, 'Not generated'],
		[{ state: 'compiling', truncated: false }, 'Generating'],
		[{ state: 'cancelled', truncated: false }, 'Cancelled'],
		[successfulStatus(false), 'Ready'],
		[
			{
				state: 'failed',
				error: new Error('expected failure'),
				diagnostics: [],
				truncated: true,
			},
			'Failed',
		],
	];
	for (const [status, expected] of statuses) {
		const details = buildArtifactDetails(snapshot(status));
		assert.equal(itemValue(details, 'state'), expected);
	}
});

test('failed artifact details retain the sanitized invocation prepared before execution', () => {
	const details = buildArtifactDetails(
		snapshot({
			state: 'failed',
			error: new Error('expected failure'),
			diagnostics: [],
			invocation: {
				executable: '/tool/clang++',
				args: ['-c', 'source.cpp'],
				cwd: '/project',
				environmentVariableNames: ['PATH'],
			},
			truncated: false,
		}),
	);
	assert.equal(itemValue(details, 'state'), 'Failed');
	assert.equal(itemValue(details, 'executable'), '/tool/clang++');
	assert.equal(itemValue(details, 'argument-1'), 'source.cpp');
	assert.deepEqual(
		findItem(details, 'environment').children?.map((item) => item.label),
		['PATH'],
	);
});

function successfulStatus(withDiagnostics = true): ArtifactStatus {
	const raw: RawArtifact = {
		kind: 'stack-analysis',
		text: '',
		diagnostics: withDiagnostics
			? [
					{ uri: {} as never, line: 0, column: 0, severity: 'error', message: 'error' },
					{ uri: {} as never, line: 0, column: 0, severity: 'warning', message: 'warning' },
					{ uri: {} as never, line: 0, column: 0, severity: 'information', message: 'note' },
				]
			: [],
		durationMs: 12.4,
		generatedAt: 1_700_000_000_000,
		command: {
			executable: '/tool chain/clang++',
			arguments: ['-O2', '-DNAME=value with spaces'],
			environmentVariableNames: ['TOKEN', 'API_KEY'],
			workingDirectory: '/project',
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
	const artifact: RenderedArtifact = {
		kind: 'stack-analysis',
		presentation: 'text',
		diagnostics: raw.diagnostics,
		durationMs: raw.durationMs,
		generatedAt: raw.generatedAt,
		command: invocationDetails(raw.command),
		text: raw.text,
		lines: [],
		sourceLocations: [],
		links: [],
		folds: [],
		symbols: [],
		metrics: { largestFrame: 64, functionCount: 3 },
		raw: raw.text,
		truncated: false,
		toolOutputTruncated: false,
	};
	return {
		state: 'successful',
		assembly: {} as never,
		artifact,
		truncated: false,
	};
}

function snapshot(status: ArtifactStatus): ArtifactDocumentSnapshot {
	return {
		identity: {
			documentUri: 'coglens-artifact:/project/source.stack.cpp',
			sourceUri: 'file:///project/source.cpp',
			sourceLabel: '/project/source.cpp',
			artifactKind: 'stack-analysis',
			artifactLabel: 'Stack analysis',
			presetId: 'default',
			variantId: 'cmake:debug',
			variantLabel: 'Debug',
			toolchainId: 'cmake:clang',
			toolchainLabel: 'Clang 20',
			toolchainKind: 'clang',
			renderedIdentity: 'coglens-artifact:/project/source.stack.cpp',
		},
		status,
	};
}

function itemValue(items: readonly ArtifactDetailsItem[], id: string): string | undefined {
	return findItem(items, id).value;
}

function findItem(items: readonly ArtifactDetailsItem[], id: string): ArtifactDetailsItem {
	for (const item of items) {
		if (item.id === id) {
			return item;
		}
		const nested = item.children ? tryFindItem(item.children, id) : undefined;
		if (nested) {
			return nested;
		}
	}
	throw new Error(`Details item not found: ${id}`);
}

function tryFindItem(items: readonly ArtifactDetailsItem[], id: string): ArtifactDetailsItem | undefined {
	for (const item of items) {
		if (item.id === id) {
			return item;
		}
		const nested = item.children ? tryFindItem(item.children, id) : undefined;
		if (nested) {
			return nested;
		}
	}
	return undefined;
}
