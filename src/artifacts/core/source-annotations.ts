import { sameLocalFileTest } from '../../file-identity.js';
import type {
	ArtifactLineAnnotation,
	ArtifactLineAnnotationStyle,
	OptimizationRemarkCategory,
	RenderedTextArtifact,
} from '../../types/index.js';

/** The annotations of one source line in one style. */
export interface SourceLineAnnotation {
	/** The zero-based source line. */
	readonly line: number;
	readonly style: ArtifactLineAnnotationStyle;
	/** The short texts, which show at the end of the line. */
	readonly texts: readonly string[];
}

/** Whether the editors show an annotation. A remark shows only when its category is selected. */
export function annotationShows(
	annotation: ArtifactLineAnnotation,
	categories: ReadonlySet<OptimizationRemarkCategory>,
): boolean {
	return annotation.kind !== 'optimization-remark' || categories.has(annotation.category);
}

/**
 * The annotations of a listing on the lines of one source file, by line and style. A text that
 * repeats on a line shows once.
 */
export function sourceLineAnnotations(
	artifact: RenderedTextArtifact,
	sourceFile: string,
	categories: ReadonlySet<OptimizationRemarkCategory>,
): SourceLineAnnotation[] {
	const isSource = sameLocalFileTest(sourceFile);
	const grouped = new Map<string, { line: number; style: ArtifactLineAnnotationStyle; texts: Set<string> }>();
	for (const artifactLine of artifact.lines) {
		const source = artifactLine.source;
		if (!artifactLine.annotations?.length || !source?.file || !source.line || !isSource(source.file)) {
			continue;
		}
		for (const annotation of artifactLine.annotations) {
			if (!annotationShows(annotation, categories)) {
				continue;
			}
			const line = source.line - 1;
			const key = `${line}\0${annotation.style}`;
			const entry = grouped.get(key) ?? { line, style: annotation.style, texts: new Set<string>() };
			entry.texts.add(annotation.text);
			grouped.set(key, entry);
		}
	}
	return [...grouped.values()]
		.map((entry) => ({ line: entry.line, style: entry.style, texts: [...entry.texts] }))
		.sort((left, right) => left.line - right.line);
}
