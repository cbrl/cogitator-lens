import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderControlFlowGraphArtifact } from './control-flow-graph-renderer.js';

export const controlFlowGraphArtifact = {
	presentation: 'graph',
	requiresOutputSelection: true,
	label: 'Control-flow graph',
	icon: 'type-hierarchy',
	filenameExtension: '.cfg',
	documentLanguage: 'artifact',
	options: [],
	renderer: renderControlFlowGraphArtifact,
	navigation: {
		definitions: false,
		sourceLocations: false,
		links: false,
		folds: false,
		symbols: false,
	},
	metricLabels: {
		graphCount: 'Function graphs',
		nodeCount: 'Basic blocks',
		edgeCount: 'Control-flow edges',
		branchNodeCount: 'Branch blocks',
		unreachableNodeCount: 'Unreachable blocks',
		sourceMappedNodeCount: 'Source-mapped blocks',
	},
} as const satisfies ArtifactDefinition;
