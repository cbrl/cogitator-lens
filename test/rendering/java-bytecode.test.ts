import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { classifyArtifactLine } from '../../src/artifacts/core/listing-syntax.js';
import { javaBytecodeListing, javaInstructionDocumentation } from '../../src/artifacts/java/java-bytecode-listing.js';
import {
	descriptorParameters,
	parseJavapListing,
	renderJavaBytecode,
} from '../../src/artifacts/java/java-bytecode-renderer.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

const sourcePath = path.resolve('/project/src/com/example/Shapes.java');

/** `javap -c -l -p -constants` of the four class files of the fixture, from JDK 21 on Linux and JDK 27 on Windows. */
const fixtures = {
	'javap 21': readFixture('java', 'javap-shapes-jdk21.txt'),
	'javap 27': readFixture('java', 'javap-shapes-jdk27.txt'),
};

function lineOf(listing: ReturnType<typeof parseJavapListing>, pattern: RegExp, after = 0): number {
	const index = listing.lines.findIndex((line, lineIndex) => lineIndex >= after && pattern.test(line.text));
	assert.ok(index >= 0, `no line matches ${pattern}`);
	return index;
}

function symbolLine(listing: ReturnType<typeof parseJavapListing>, name: string): number {
	const symbol = listing.symbols.find((candidate) => candidate.name === name);
	assert.ok(symbol, `no symbol ${name}`);
	return symbol.line;
}

for (const [label, text] of Object.entries(fixtures)) {
	test(`${label}: the listing hides the code headers and the line tables, and maps each instruction`, () => {
		const listing = parseJavapListing(text, sourcePath);
		assert.ok(
			listing.lines.every(
				(line) => !/^\s*(?:Code:|LineNumberTable:|line \d+: \d+|Compiled from)/u.test(line.text),
			),
		);
		const sum = symbolLine(listing, 'com.example.Shapes.sum(int[])');
		assert.equal(listing.lines[lineOf(listing, /if_icmpge/u, sum)].source?.line, 21);
		assert.equal(listing.lines[lineOf(listing, /: iadd/u, sum)].source?.line, 22);
		assert.equal(listing.lines[lineOf(listing, /: ireturn/u, sum)].source?.line, 24);
		const mapped = listing.lines[lineOf(listing, /: iadd/u, sum)].source;
		assert.deepEqual(mapped, { file: sourcePath, line: 22, mainSource: true });
		// A field and a signature have no source line.
		assert.equal(listing.lines[lineOf(listing, /static final int LIMIT = 5;/u)].source, undefined);
		assert.equal(listing.lines[sum].source, undefined);
		assert.equal(
			listing.sourceLineCount,
			new Set(listing.lines.map((line) => line.source?.line).filter(Boolean)).size,
		);
	});

	test(`${label}: symbols name each method with code, and folds cover each method and class`, () => {
		const listing = parseJavapListing(text, sourcePath);
		const names = listing.symbols.map((symbol) => symbol.name);
		for (const name of [
			'com.example.Shapes.<init>()',
			'com.example.Shapes.<clinit>()',
			'com.example.Shapes.sum(int[])',
			'com.example.Shapes.count(java.util.List<java.lang.String>)',
			'com.example.Shapes.total(int...)',
			'com.example.Shapes$1.area()',
			'com.example.Shapes$Point.<init>(int, int)',
			'com.example.Shapes$Point.x()',
		]) {
			assert.ok(names.includes(name), name);
		}
		// An abstract method has no code.
		assert.ok(!names.some((name) => name.startsWith('com.example.Shapes$Shape.')));
		const shapes = lineOf(listing, /^public class com\.example\.Shapes \{$/u);
		const end = lineOf(listing, /^\}$/u, shapes);
		assert.ok(listing.folds.some((fold) => fold.startLine === shapes && fold.endLine === end));
		const sum = symbolLine(listing, 'com.example.Shapes.sum(int[])');
		const sumFold = listing.folds.find((fold) => fold.startLine === sum);
		assert.ok(sumFold);
		assert.match(listing.lines[sumFold.endLine].text, /ireturn/u);
		// Classes are apart by one blank line.
		const anonymous = lineOf(listing, /^class com\.example\.Shapes\$1 /u);
		assert.equal(listing.lines[anonymous - 1].text, '');
		assert.equal(listing.lines[anonymous - 2].text, '}');
	});

	test(`${label}: branches, switch cases, and exception table rows link to their instructions`, () => {
		const listing = parseJavapListing(text, sourcePath);
		const linkFrom = (line: number) => listing.links.filter((link) => link.line === line);
		const sum = symbolLine(listing, 'com.example.Shapes.sum(int[])');
		const conditional = linkFrom(lineOf(listing, /if_icmpge\s+33$/u, sum));
		assert.equal(conditional.length, 1);
		assert.match(listing.lines[conditional[0].targetLine].text, /^\s*33: iload_1$/u);
		assert.equal(conditional[0].edgeKind, 'true');
		const loop = linkFrom(lineOf(listing, /goto\s+10$/u, sum));
		assert.match(listing.lines[loop[0].targetLine].text, /^\s*10: iload\s+4$/u);
		assert.equal(loop[0].edgeKind, 'unconditional');
		assert.equal(listing.lines[loop[0].line].text.slice(loop[0].startCharacter, loop[0].endCharacter), '10');

		const name = symbolLine(listing, 'com.example.Shapes.name(int)');
		const hundred = lineOf(listing, /^\s+100: \d+$/u, name);
		assert.equal(listing.lines[hundred].source?.line, 28, 'a switch case has the line of its switch');
		const [caseLink] = linkFrom(hundred);
		assert.match(listing.lines[caseLink.targetLine].text, /ldc .*String hundred/u);
		assert.equal(caseLink.edgeKind, 'true');
		assert.equal(listing.lines[lineOf(listing, /^\s+\}$/u, name)].source?.line, 28);

		const parse = symbolLine(listing, 'com.example.Shapes.parse(java.lang.String)');
		const row = lineOf(listing, /^\s+0\s+4\s+5\s+Class java\/lang\/NumberFormatException$/u, parse);
		const targets = linkFrom(row).map((link) => listing.lines[link.targetLine].text.trim());
		// The end offset 4 is the start of `ireturn`.
		assert.deepEqual(targets, ['0: aload_0', '4: ireturn', '5: astore_1']);
	});

	test(`${label}: an invoke instruction links to the method of the listing`, () => {
		const listing = parseJavapListing(text, sourcePath);
		const callTarget = (pattern: RegExp, after: number) => {
			const line = lineOf(listing, pattern, after);
			const links = listing.links.filter((link) => link.line === line);
			return links.map((link) => ({
				text: listing.lines[line].text.slice(link.startCharacter, link.endCharacter),
				target: link.targetLine,
			}));
		};
		const total = symbolLine(listing, 'com.example.Shapes.total(int...)');
		// javap leaves out the class of a method in the same class.
		assert.deepEqual(callTarget(/Method sum:\(\[I\)I/u, total), [
			{ text: 'sum', target: symbolLine(listing, 'com.example.Shapes.sum(int[])') },
		]);
		// A method of another source is not in the listing.
		assert.deepEqual(callTarget(/Helper\.twice/u, total), []);
		const origin = symbolLine(listing, 'com.example.Shapes.origin()');
		assert.deepEqual(callTarget(/Shapes\$Point\."<init>":\(II\)V/u, origin), [
			{
				text: 'com/example/Shapes$Point."<init>"',
				target: symbolLine(listing, 'com.example.Shapes$Point.<init>(int, int)'),
			},
		]);
		assert.deepEqual(callTarget(/Shapes\$Point\.x:\(\)I/u, origin), [
			{ text: 'com/example/Shapes$Point.x', target: symbolLine(listing, 'com.example.Shapes$Point.x()') },
		]);
		// javap writes no parameters for the anonymous constructor, so the name alone selects it.
		const square = symbolLine(listing, 'com.example.Shapes.square(double)');
		assert.deepEqual(callTarget(/Shapes\$1\."<init>"/u, square), [
			{ text: 'com/example/Shapes$1."<init>"', target: symbolLine(listing, 'com.example.Shapes$1.<init>()') },
		]);
	});
}

test('javap 27 on Windows ends the lines of a switch body with \\r\\r\\n, which add no blank lines', () => {
	const unix = parseJavapListing(fixtures['javap 27'], sourcePath);
	const windows = fixtures['javap 27']
		.replace(/\n/gu, '\r\n')
		.replace(/^(\s+(?:-?\d+: \d+|\d+: (?:lookup|table)switch .*))\r\n/gmu, '$1\r\r\n');
	assert.match(windows, /\r\r\n/u);
	assert.deepEqual(parseJavapListing(windows, sourcePath), unix);
});

test('the classes of another source have no source lines', () => {
	const text = fixtures['javap 27'].replace('Compiled from "Shapes.java"', 'Compiled from "Other.java"');
	const listing = parseJavapListing(text, sourcePath);
	const sum = symbolLine(listing, 'com.example.Shapes.sum(int[])');
	assert.equal(listing.lines[lineOf(listing, /: iadd/u, sum)].source, undefined);
	const area = symbolLine(listing, 'com.example.Shapes$1.area()');
	assert.equal(listing.lines[lineOf(listing, /: dmul/u, area)].source?.line, 46);
});

test('the renderer gives the listing, its navigation, and its metrics', () => {
	const rendered = renderJavaBytecode(
		rawArtifact('assembly', fixtures['javap 21']),
		defaultArtifactOptions.display,
		renderContext('java', { file: sourcePath }),
	);
	const listing = parseJavapListing(fixtures['javap 21'], sourcePath);
	assert.deepEqual(rendered.lines, listing.lines);
	assert.deepEqual(rendered.symbols, listing.symbols);
	assert.equal(rendered.links.length, listing.links.length);
	assert.equal(rendered.metrics.methodCount, listing.symbols.length);
	assert.equal(rendered.metrics.instructionCount, listing.instructionCount);
	assert.ok(listing.instructionCount > 50);
	const empty = renderJavaBytecode(
		rawArtifact('assembly', ''),
		defaultArtifactOptions.display,
		renderContext('java'),
	);
	assert.deepEqual(empty.lines, []);
	assert.equal(empty.metrics.methodCount, 0);
});

test('a method descriptor gives the parameter types as javap writes them', () => {
	assert.equal(
		descriptorParameters('(I[Ljava/lang/String;[[DLcom/example/Shapes$Point;)V'),
		'int,java.lang.String[],double[][],com.example.Shapes$Point',
	);
	assert.equal(descriptorParameters('()V'), '');
	assert.equal(descriptorParameters('(Ljava/lang/String'), undefined);
	assert.equal(descriptorParameters('I'), undefined);
});

test('the JVM bytecode listing finds the mnemonic, its documentation, and its tokens', () => {
	const instruction = '        13: if_icmpge     33';
	assert.equal(javaBytecodeListing.mnemonic(instruction), 'if_icmpge');
	assert.equal(javaBytecodeListing.mnemonic('                       1: 44'), undefined);
	assert.equal(javaBytecodeListing.mnemonic('  public static int sum(int[]);'), undefined);

	assert.match(javaInstructionDocumentation('ireturn')?.tooltip ?? '', /Return int/u);
	// The vendored table has one entry for each of these instruction families.
	for (const [mnemonic, shared] of [
		['if_icmplt', 'if_icmpeq'],
		['ifge', 'ifeq'],
		['fconst_1', 'fconst_0, 1'],
	] as const) {
		const documentation = javaInstructionDocumentation(mnemonic);
		assert.ok(documentation, mnemonic);
		assert.equal(documentation.url, javaInstructionDocumentation(shared)?.url);
		assert.match(documentation.html, new RegExp(`^<p>Instruction ${mnemonic}:`, 'u'));
	}
	assert.equal(javaInstructionDocumentation('nosuchop'), null);

	const tokens = javaBytecodeListing.tokens('         1: invokestatic  #42                 // Method sum:([I)I');
	assert.deepEqual(
		tokens.map((token) => [token.type, token.start, token.length]),
		[
			['label', 9, 1],
			['keyword', 12, 12],
			['variable', 26, 3],
		],
	);
	assert.deepEqual(
		javaBytecodeListing
			.tokens('public final class com.example.Shapes$Point extends java.lang.Record {')
			.map((token) => token.type),
		['keyword', 'keyword', 'keyword', 'keyword'],
	);
	// The comment of the listing hides the words in it, such as `Method`.
	const classified = classifyArtifactLine(
		'         1: invokestatic  #42                 // Method sum:([I)I',
		javaBytecodeListing,
		{ isDocumentedOpcode: () => true },
	);
	assert.deepEqual(
		classified.map((token) => token.type),
		['label', 'keyword', 'variable', 'comment'],
	);
});
