/**
 * Shows the optimization remarks of real rustc, Go, and cl.exe compiles.
 *
 * Each test needs its compiler and skips when it is absent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectVisualStudioToolchains } from '../../src/toolchains/visual-studio-detection.js';
import {
	defaultArtifactOptions,
	type ProducedArtifact,
	type RenderedArtifact,
	type ToolchainKind,
	type ToolchainProfile,
} from '../../src/types/index.js';
import { renderContext } from '../support/artifacts.js';
import { fixturePath, readFixture, requireCommand } from '../support/environment.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

interface RemarkRun {
	readonly produced: ProducedArtifact;
	/** The annotation texts of each source line. */
	readonly remarks: ReadonlyMap<number, readonly string[]>;
	readonly rendered: RenderedArtifact;
}

/** Compiles a copy of a fixture source in a new folder, and renders its remarks. */
async function remarks(
	kind: ToolchainKind,
	executable: string,
	name: string,
	args: readonly string[],
	profile: Partial<ToolchainProfile> = {},
	runs = 1,
): Promise<RemarkRun[]> {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-remarks-'));
	try {
		const source = path.join(temporary, name);
		await fs.promises.copyFile(fixturePath('optimization-remarks', name), source);
		const backend = toolchainBackend(kind, { ...profile, executable });
		const implementation = declaredImplementation(kind, 'optimization-remarks');
		const results: RemarkRun[] = [];
		for (let run = 0; run < runs; run += 1) {
			const produced = await implementation.producer(
				backend,
				sourceUri(source),
				{ args, workingDirectory: temporary, productionOptions: defaultArtifactOptions.production },
				neverCancelled,
			);
			const rendered = await implementation.renderer!(
				{ ...produced, kind: 'optimization-remarks' },
				defaultArtifactOptions.display,
				renderContext(backend, { file: source, text: readFixture('optimization-remarks', name) }),
			);
			assert.equal(rendered.presentation, 'text');
			const byLine = new Map<number, string[]>();
			for (const line of rendered.presentation === 'text' ? rendered.lines : []) {
				for (const annotation of line.annotations ?? []) {
					const sourceLine = line.source?.line ?? 0;
					byLine.set(sourceLine, [...(byLine.get(sourceLine) ?? []), annotation.text]);
				}
			}
			results.push({ produced, remarks: byLine, rendered });
		}
		return results;
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

const diagnosticsOf = (run: RemarkRun) =>
	run.produced.diagnostics.map(
		(diagnostic) => `${diagnostic.line + 1} ${diagnostic.severity}: ${diagnostic.message}`,
	);

test('rustc remarks show on the source, and its warnings stay diagnostics', async (t) => {
	if (!requireCommand(t, 'rustc')) {
		return;
	}
	const [run] = await remarks('rust', 'rustc', 'remarks.rs', ['-C', 'opt-level=2']);
	assert.deepEqual(diagnosticsOf(run), ['28 warning: unused variable: `unused`']);
	assert.ok(
		run.remarks.get(22)?.some((text) => /^\[missed\] inline: '\w+' not inlined into '\w+'/u.test(text)),
		`Line 22: ${run.remarks.get(22)?.join(' | ')}`,
	);
	assert.ok(run.remarks.get(29)?.includes('[missed] loop-vectorize: loop not vectorized'));
	assert.ok(![...run.remarks.values()].flat().some((text) => text.includes('size-info')));
});

test('Go remarks show on the source, also when the build cache prints them again', async (t) => {
	if (!requireCommand(t, 'go', 'version')) {
		return;
	}
	const runs = await remarks('go', 'go', 'remarks.go', [], {}, 2);
	for (const run of runs) {
		assert.deepEqual(diagnosticsOf(run), []);
		assert.deepEqual(run.remarks.get(23), [
			'[missed] inline: cannot inline complex: function too complex: cost 122 exceeds budget 80',
			'[passed] escape: values does not escape',
		]);
		assert.deepEqual(run.remarks.get(18), ['[passed] inline: inlining call to add']);
	}
	assert.equal(runs[1].produced.text, runs[0].produced.text, 'The second build prints the same remarks');
});

test('cl.exe loop remarks show on the source, and its warnings stay diagnostics', async (t) => {
	const msvc = (await detectVisualStudioToolchains(process.env, process.platform)).find(
		(candidate) => candidate.kind === 'msvc',
	);
	if (!msvc) {
		t.skip('no Visual Studio cl.exe is installed');
		return;
	}
	const [run] = await remarks('msvc', msvc.executable, 'remarks.cpp', ['/O2', '/W4'], msvc);
	assert.deepEqual(diagnosticsOf(run), ["19 warning: C4101: 'unused': unreferenced local variable"]);
	assert.deepEqual(run.remarks.get(5), ['[passed] vectorizer: loop vectorized']);
	assert.deepEqual(run.remarks.get(12), [
		"[missed] vectorizer: loop not vectorized due to reason '502': Induction variable is stepped in some manner other than a simple +1.",
	]);
	assert.equal(run.rendered.metrics.remarkCount, 3);
});
