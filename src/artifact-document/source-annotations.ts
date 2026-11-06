import { Disposable, MarkdownString, Range, window, workspace, type TextEditor } from 'vscode';
import { sourceLineAnnotations, type SourceLineAnnotation } from '../artifacts/core/source-annotations.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { ArtifactLineAnnotationStyle, ArtifactKind } from '../types/index.js';
import type { ArtifactDocumentRegistry } from './artifact-document-registry.js';
import { currentListing } from './artifact-generator.js';
import { createAnnotationStyleDecorations } from './decorations/decoration-styles.js';

/** The artifact kinds whose lines carry analysis annotations for their source. */
const analysisKinds: ReadonlySet<ArtifactKind> = new Set(['optimization-remarks', 'stack-analysis']);

/**
 * Shows the optimization remarks and the stack usage of open artifacts at the end of the source
 * lines. A source with unsaved edits shows none, because the compiler read the saved file.
 */
export class SourceAnnotations implements Disposable {
	private readonly decorations = createAnnotationStyleDecorations();
	private readonly subscriptions: Disposable;

	constructor(
		private readonly registry: ArtifactDocumentRegistry,
		private readonly configuration: ConfigurationService,
	) {
		const refresh = (): void => this.refresh();
		this.subscriptions = Disposable.from(
			registry.onDidChangeArtifactState(refresh),
			registry.onDidChangeDocuments(refresh),
			window.onDidChangeVisibleTextEditors(refresh),
			workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.scheme === 'file') {
					this.refreshEditors(
						window.visibleTextEditors.filter((editor) => editor.document === event.document),
					);
				}
			}),
			workspace.onDidSaveTextDocument(refresh),
			configuration.onDidChange((change) => {
				if (change.affects('showAnalysisOnSource') || change.affects('optimizationRemarkCategories')) {
					refresh();
				}
			}),
			...Object.values(this.decorations),
		);
		this.refresh();
	}

	dispose(): void {
		this.subscriptions.dispose();
	}

	private refresh(): void {
		this.refreshEditors(window.visibleTextEditors.filter((editor) => editor.document.uri.scheme === 'file'));
	}

	private refreshEditors(editors: readonly TextEditor[]): void {
		const categories = this.configuration.getOptimizationRemarkCategories();
		for (const editor of editors) {
			const document = editor.document;
			const annotations =
				document.isDirty || !this.configuration.getShowAnalysisOnSource(document.uri)
					? []
					: this.registry.documentsOf(document.uri).flatMap((artifactDocument) => {
							// Only a successful compile matches the saved file. An earlier result has the old lines.
							const artifact = currentListing(artifactDocument.handler.status);
							return artifact && analysisKinds.has(artifactDocument.parsed.artifactKind)
								? sourceLineAnnotations(artifact, document.uri.fsPath, categories)
								: [];
						});
			const byStyle = new Map<ArtifactLineAnnotationStyle, SourceLineAnnotation[]>();
			for (const annotation of annotations) {
				if (annotation.line < document.lineCount) {
					byStyle.set(annotation.style, [...(byStyle.get(annotation.style) ?? []), annotation]);
				}
			}
			for (const [style, decoration] of Object.entries(this.decorations) as Array<
				[ArtifactLineAnnotationStyle, (typeof this.decorations)[ArtifactLineAnnotationStyle]]
			>) {
				editor.setDecorations(
					decoration,
					(byStyle.get(style) ?? []).map((annotation) => {
						// The range covers the line, so a hover anywhere on it shows the full texts.
						const line = document.lineAt(annotation.line).range;
						const hover = new MarkdownString();
						hover.appendText(annotation.texts.join('\n'));
						return {
							range: new Range(line.start, line.end),
							hoverMessage: hover,
							renderOptions: { after: { contentText: annotation.texts.join(' · ') } },
						};
					}),
				);
			}
		}
	}
}
