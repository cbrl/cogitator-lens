import type { ArtifactDocumentSnapshot } from '../../artifact-document/artifact-identity.js';
import type { ArtifactStatus } from '../../artifact-document/artifact-generator.js';
import type {
	CompileDiagnostic,
	InvocationDetails,
	RenderedArtifact,
	RenderedArtifactMetric,
} from '../../types/index.js';
import { uniqueDiagnostics } from '../../diagnostics.js';

export interface ArtifactDetailsItem {
	readonly id: string;
	readonly label: string;
	readonly value?: string;
	readonly copyText?: string;
	readonly children?: readonly ArtifactDetailsItem[];
}

export function buildArtifactDetails(
	snapshot: ArtifactDocumentSnapshot,
	metricLabels: Readonly<Record<string, string>> = {},
): readonly ArtifactDetailsItem[] {
	const { identity, status } = snapshot;
	const artifact = status.artifact;
	const diagnostics = currentDiagnostics(status, artifact);
	const invocation = status.invocation ?? artifact?.command;
	const counts = countDiagnostics(diagnostics);

	return Object.freeze([
		group('artifact', 'Artifact', [
			value('artifact-label', 'Artifact', identity.artifactLabel),
			value('kind', 'Kind', identity.artifactKind),
			...(identity.artifactOutputId ? [value('artifact-output', 'Output', identity.artifactLabel)] : []),
			value('source', 'Source', identity.sourceLabel),
			value('preset', 'Preset', identity.presetId),
			value('variant', 'Variant', identity.variantLabel),
			value('variant-id', 'Variant ID', identity.variantId),
			value('toolchain', 'Toolchain', identity.toolchainLabel),
			value('toolchain-kind', 'Toolchain kind', identity.toolchainKind),
			value('toolchain-id', 'Toolchain ID', identity.toolchainId),
			value('document-uri', 'Document URI', identity.documentUri),
		]),
		group('status', 'Status', [
			value('state', 'State', statusLabel(status)),
			value('duration', 'Duration', artifact ? formatDuration(artifact.durationMs) : 'Not available'),
			value('generated', 'Generated', artifact ? new Date(artifact.generatedAt).toISOString() : 'Not available'),
			value('truncated', 'Output truncated', status.truncated ? 'Yes' : 'No'),
			value('errors', 'Errors', String(counts.error)),
			value('warnings', 'Warnings', String(counts.warning)),
			value('information', 'Information', String(counts.information)),
			...(status.state === 'failed' ? [value('failure', 'Failure', status.error.message)] : []),
		]),
		group(
			'invocation',
			'Invocation',
			invocation ? invocationItems(invocation) : [empty('invocation-unavailable', 'Not available')],
		),
		group(
			'environment',
			'Environment',
			invocation
				? environmentItems(invocation.environmentVariableNames)
				: [empty('environment-unavailable', 'Not available')],
		),
		group(
			'metrics',
			'Metrics',
			artifact ? metricItems(artifact.metrics, metricLabels) : [empty('metrics-unavailable', 'Not available')],
		),
	]);
}

function currentDiagnostics(
	status: ArtifactStatus,
	artifact: RenderedArtifact | undefined,
): readonly CompileDiagnostic[] {
	if (status.state !== 'failed') {
		return artifact?.diagnostics ?? [];
	}
	return uniqueDiagnostics([...(artifact?.diagnostics ?? []), ...status.diagnostics]);
}

function statusLabel(status: ArtifactStatus): string {
	switch (status.state) {
		case 'compiling':
			return 'Generating';
		case 'successful':
			return status.artifact.diagnostics.length > 0 ? 'Ready with diagnostics' : 'Ready';
		case 'cancelled':
			return 'Cancelled';
		case 'failed':
			return 'Failed';
		case 'stale':
			return status.artifact ? 'Stale because an input changed' : 'Not generated';
	}
}

function countDiagnostics(diagnostics: readonly CompileDiagnostic[]): Record<CompileDiagnostic['severity'], number> {
	const result = { error: 0, warning: 0, information: 0 };
	for (const diagnostic of diagnostics) {
		result[diagnostic.severity]++;
	}
	return result;
}

function invocationItems(invocation: InvocationDetails): ArtifactDetailsItem[] {
	const commandLine = [invocation.executable, ...invocation.args].map(formatCommandArgument).join(' ');
	return [
		value('command-line', 'Command line', commandLine),
		value('executable', 'Executable', invocation.executable),
		group(
			'arguments',
			'Arguments',
			invocation.args.length
				? invocation.args.map((argument, index) =>
						value(`argument-${index}`, `Argument ${index + 1}`, argument),
					)
				: [empty('arguments-none', '(none)')],
		),
		value('working-directory', 'Working directory', invocation.cwd),
	];
}

function environmentItems(names: readonly string[]): ArtifactDetailsItem[] {
	return names.length
		? [...names].sort(compareText).map((name) => value(`environment-${encodeURIComponent(name)}`, name, name))
		: [empty('environment-none', '(none)')];
}

function metricItems(
	metrics: Readonly<Record<string, RenderedArtifactMetric>>,
	labels: Readonly<Record<string, string>>,
): ArtifactDetailsItem[] {
	const entries = Object.entries(metrics).sort(([left], [right]) => compareText(left, right));
	return entries.length
		? entries.map(([key, metric]) => value(`metric-${key}`, labels[key] ?? humanizeIdentifier(key), String(metric)))
		: [empty('metrics-none', '(none)')];
}

function formatCommandArgument(argument: string): string {
	return argument && !/[\s"']/u.test(argument) ? argument : JSON.stringify(argument);
}

function formatDuration(durationMs: number): string {
	return `${Math.max(0, durationMs).toFixed(durationMs < 10 ? 1 : 0)} ms`;
}

function humanizeIdentifier(identifier: string): string {
	const words = identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

function group(id: string, label: string, children: readonly ArtifactDetailsItem[]): ArtifactDetailsItem {
	return { id, label, children };
}

function value(id: string, label: string, itemValue: string): ArtifactDetailsItem {
	return { id, label, value: itemValue, copyText: itemValue };
}

function empty(id: string, label: string): ArtifactDetailsItem {
	return { id, label };
}
