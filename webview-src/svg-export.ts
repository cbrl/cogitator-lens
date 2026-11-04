/** The presentation properties that the graph stylesheet sets on SVG elements. */
export const exportedStyleProperties = [
	'fill',
	'fill-opacity',
	'stroke',
	'stroke-width',
	'stroke-dasharray',
	'stroke-linejoin',
	'stroke-opacity',
	'paint-order',
	'opacity',
	'font-family',
	'font-size',
	'font-weight',
	'text-anchor',
	'dominant-baseline',
] as const;

const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';

/** The parts of a DOM element that the export reads and writes. */
export interface ExportElement {
	readonly localName: string;
	readonly children: ArrayLike<ExportElement>;
	setAttribute(name: string, value: string): void;
	setAttributeNS(namespace: string | null, qualifiedName: string, value: string): void;
}

export interface ComputedStyle {
	getPropertyValue(property: string): string;
}

/**
 * Copies the computed presentation styles of each source element to the matching element of its
 * clone. An exported file cannot read the webview stylesheet or the theme variables of VS Code.
 */
export function inlineComputedStyles(
	source: ExportElement,
	clone: ExportElement,
	computedStyle: (element: ExportElement) => ComputedStyle,
): void {
	const style = computedStyle(source);
	const declarations = exportedStyleProperties.flatMap((property) => {
		const value = style.getPropertyValue(property).trim();
		return value ? [`${property}: ${value}`] : [];
	});
	if (declarations.length > 0) {
		clone.setAttribute('style', declarations.join('; '));
	}
	if (source.localName === 'text') {
		// Block text is code. Without this attribute, an SVG viewer collapses its spaces.
		clone.setAttributeNS(xmlNamespace, 'xml:space', 'preserve');
	}
	const count = Math.min(source.children.length, clone.children.length);
	for (let index = 0; index < count; index++) {
		inlineComputedStyles(source.children[index], clone.children[index], computedStyle);
	}
}
