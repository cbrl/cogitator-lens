import type { ArtifactDefinition } from '../core/artifact-contracts.js';

export const controlFlowGraphArtifact = {
	label: 'Control-flow graph',
	options: [],
	presentation: 'graph',
	requiresOutputSelection: true,
	icon: 'type-hierarchy',
	filenameExtension: '.cfg',
	documentLanguage: 'artifact',
	metricLabels: {
		graphCount: 'Function graphs',
		nodeCount: 'Basic blocks',
		edgeCount: 'Control-flow edges',
		branchNodeCount: 'Branch blocks',
		unreachableNodeCount: 'Unreachable blocks',
		sourceMappedNodeCount: 'Source-mapped blocks',
	},
} as const satisfies ArtifactDefinition;
