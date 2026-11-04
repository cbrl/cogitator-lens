import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineComputedStyles, type ExportElement } from '../../webview-src/svg-export.js';

class FakeElement implements ExportElement {
	readonly attributes = new Map<string, string>();

	constructor(
		readonly localName: string,
		readonly computed: Readonly<Record<string, string>> = {},
		readonly children: FakeElement[] = [],
	) {}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	setAttributeNS(_namespace: string | null, name: string, value: string): void {
		this.attributes.set(name, value);
	}
}

/** Builds an unstyled copy with the same shape, as `cloneNode(true)` does. */
function clone(element: FakeElement): FakeElement {
	return new FakeElement(element.localName, {}, element.children.map(clone));
}

test('an exported graph carries the computed styles of the webview stylesheet', () => {
	const label = new FakeElement('text', { fill: 'rgb(204, 204, 204)', 'font-family': 'Consolas' });
	const edge = new FakeElement('path', {
		stroke: 'rgb(115, 201, 145)',
		opacity: '0.72',
		'stroke-dasharray': ' 8 3 ',
	});
	const group = new FakeElement('g', {}, [label, edge]);
	const source = new FakeElement('svg', { fill: 'rgb(0, 0, 0)' }, [group]);
	const copy = clone(source);

	inlineComputedStyles(source, copy, (element) => ({
		getPropertyValue: (property) => (element as FakeElement).computed[property] ?? '',
	}));

	const [copiedGroup] = copy.children;
	const [copiedLabel, copiedEdge] = copiedGroup.children;
	assert.equal(copy.attributes.get('style'), 'fill: rgb(0, 0, 0)');
	assert.equal(copiedGroup.attributes.has('style'), false, 'An element without styles gets no style attribute');
	assert.equal(copiedLabel.attributes.get('style'), 'fill: rgb(204, 204, 204); font-family: Consolas');
	assert.equal(copiedLabel.attributes.get('xml:space'), 'preserve');
	assert.equal(
		copiedEdge.attributes.get('style'),
		'stroke: rgb(115, 201, 145); stroke-dasharray: 8 3; opacity: 0.72',
	);
	assert.equal(copiedEdge.attributes.has('xml:space'), false);
});

test('a clone with fewer children than its source is styled without an error', () => {
	const source = new FakeElement('g', {}, [new FakeElement('rect', { fill: 'red' })]);
	const copy = new FakeElement('g');
	inlineComputedStyles(source, copy, (element) => ({
		getPropertyValue: (property) => (element as FakeElement).computed[property] ?? '',
	}));
	assert.equal(copy.attributes.size, 0);
});
