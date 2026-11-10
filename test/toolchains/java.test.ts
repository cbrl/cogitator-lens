import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	classFiles,
	compareClassNames,
	findJavap,
	javacArguments,
	javacVerboseInputs,
	javaPackage,
	javapArguments,
	javaSourceRoot,
	runJavac,
	splitVerboseLines,
	stripJavaManagedArguments,
} from '../../src/toolchains/java.js';
import { parseJavacDiagnostics } from '../../src/toolchains/java/diagnostics.js';
import { ToolExitError } from '../../src/toolchains/toolchain-backend.js';
import { neverCancelled, sourceUri } from '../support/toolchains.js';

/** A source URI that can name another file, as a diagnostic in another source needs. */
function fileUri(file: string): never {
	return Object.assign(sourceUri(file) as object, {
		with: ({ path: uriPath }: { readonly path: string }) =>
			fileUri(/^\/[A-Za-z]:\//u.test(uriPath) ? uriPath.slice(1).replaceAll('/', '\\') : uriPath),
	}) as never;
}

function temporaryFolder(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-java-'));
}

function touch(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '');
	return file;
}

test('the package declaration gives the source root that javac searches', () => {
	assert.equal(javaPackage('package com.example;\nclass A {}'), 'com.example');
	assert.equal(
		javaPackage('\uFEFF/* Licence: package wrong; */\n// package wrong;\npackage  com . example ;'),
		'com.example',
	);
	assert.equal(javaPackage('@Deprecated\n@SuppressWarnings("x")\npackage p.q;'), 'p.q');
	assert.equal(javaPackage('import java.util.List;\nclass A { String s = "package x;"; }'), undefined);
	assert.equal(javaPackage('class A {}\npackage late;'), undefined);
	// A `/*` in a line comment does not start a block comment.
	assert.equal(javaPackage('// see /* legacy\npackage com.example;\n/* doc */ class A {}'), 'com.example');
	assert.equal(javaPackage('/* a // b */ /* c */\npackage p;'), 'p');
	// The arguments of annotations can hold annotations, parentheses, and comment markers in strings.
	assert.equal(javaPackage('@Ann(x = @B(1), y = "a)b;")\n@See("http://x")\npackage p.q;'), 'p.q');
	assert.equal(javaPackage('@Ann(@B(@C(1)))\npackage p;'), 'p');

	assert.equal(javaSourceRoot('/w/src/com/example/A.java', 'package com.example;', 'linux'), '/w/src');
	assert.equal(javaSourceRoot('/w/src/A.java', 'class A {}', 'linux'), '/w/src');
	// The folders do not match the package, so javac gets no source path.
	assert.equal(javaSourceRoot('/w/src/other/A.java', 'package com.example;', 'linux'), undefined);
	assert.equal(javaSourceRoot('/w/src/com/Example/A.java', 'package com.example;', 'linux'), undefined);
	assert.equal(javaSourceRoot('C:\\w\\src\\com\\Example\\A.java', 'package com.example;', 'win32'), 'C:\\w\\src');
});

test('javac writes the class files into the temporary folder, and project arguments replace the defaults', () => {
	assert.deepEqual(javacArguments('/tmp/c', [], '/w/src'), [
		'-d',
		'/tmp/c',
		'-implicit:none',
		'-J-Duser.language=en',
		'-encoding',
		'UTF-8',
		'-sourcepath',
		'/w/src',
	]);
	assert.deepEqual(javacArguments('/tmp/c', ['-encoding', 'Cp1252', '--source-path=lib'], '/w/src'), [
		'-d',
		'/tmp/c',
		'-implicit:none',
		'-J-Duser.language=en',
	]);
	assert.deepEqual(javacArguments('/tmp/c', ['-sourcepath', 'a'], undefined), [
		'-d',
		'/tmp/c',
		'-implicit:none',
		'-J-Duser.language=en',
		'-encoding',
		'UTF-8',
	]);
	assert.deepEqual(javapArguments(['A.class']), ['-c', '-l', '-p', '-constants', 'A.class']);
	assert.deepEqual(
		stripJavaManagedArguments(
			[
				'-d',
				'out',
				'-s',
				'gen',
				'-h',
				'jni',
				'-implicit:class',
				'-verbose',
				'-J-Duser.language=de',
				'-J-Xmx1g',
				'-g',
				'--release',
				'21',
				'/w/A.java',
			],
			'/w/A.java',
			'/w',
		),
		['-J-Xmx1g', '-g', '--release', '21'],
	);
});

test('class files come in the order of their class names, with a class before its nested classes', async () => {
	assert.ok(compareClassNames(['p', 'A'], ['p', 'A', '1']) < 0);
	assert.ok(compareClassNames(['p', 'A', '2'], ['p', 'A', '10']) < 0);
	assert.ok(compareClassNames(['p', 'A', '10'], ['p', 'A', 'Inner']) < 0);
	assert.ok(compareClassNames(['a', 'Z'], ['b', 'A']) < 0);
	assert.equal(compareClassNames(['p', 'A'], ['p', 'A']), 0);

	const folder = temporaryFolder();
	try {
		for (const name of ['A$10.class', 'A$2.class', 'A$Inner.class', 'A.class', 'B.class']) {
			touch(path.join(folder, 'com', 'example', name));
		}
		touch(path.join(folder, 'Top.class'));
		touch(path.join(folder, 'overlay', 'A.java'));
		touch(path.join(folder, 'javac-inputs.txt'));
		assert.deepEqual(
			(await classFiles(folder)).map((file) => path.relative(folder, file).replaceAll('\\', '/')),
			[
				'Top.class',
				'com/example/A.class',
				'com/example/A$2.class',
				'com/example/A$10.class',
				'com/example/A$Inner.class',
				'com/example/B.class',
			],
		);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

/** The `-verbose` lines of javac 21 on Linux and javac 27 on Windows, without most JDK classes. */
const verboseLinux = [
	'[parsing started SimpleFileObject[/w/src/com/example/Shapes.java]]',
	'[parsing completed 12ms]',
	'[search path for source files: src]',
	'[search path for class files: /opt/jdk/lib/modules,.]',
	'[loading /modules/java.base/java/lang/Object.class]',
	'[checking com.example.Shapes]',
	'[loading src/com/example/Helper.java]',
	'[parsing started DirectoryFileObject[src:com/example/Helper.java]]',
	'[loading lib/helper.jar(/com/example/Util.class)]',
	'[loading /w/classes/com/example/Old.class]',
	'[wrote out/com/example/Shapes.class]',
	'[total 210ms]',
].join('\n');

test('the -verbose lines of javac give the sources and the class files that the compile read', () => {
	assert.deepEqual(javacVerboseInputs(verboseLinux, '/w'), [
		path.resolve('/w/src/com/example/Shapes.java'),
		path.resolve('/w/src/com/example/Helper.java'),
		path.resolve('/w/lib/helper.jar'),
		path.resolve('/w/classes/com/example/Old.class'),
	]);
	const windows = [
		'[parsing started SimpleFileObject[C:\\w\\src\\com\\example\\Shapes.java]]',
		'[parsing started DirectoryFileObject[C:\\w\\src:com/example/Helper.java]]',
		'[loading lib\\helper.jar(/com/example/Util.class)]',
	].join('\r\n');
	const inputs = javacVerboseInputs(windows, 'C:\\w');
	assert.equal(inputs.length, 3);
	if (process.platform === 'win32') {
		assert.deepEqual(inputs, [
			'C:\\w\\src\\com\\example\\Shapes.java',
			'C:\\w\\src\\com\\example\\Helper.java',
			'C:\\w\\lib\\helper.jar',
		]);
	}
	assert.deepEqual(javacVerboseInputs('[parsing started RegularFileObject[A.java]]\n[total 5ms]', '/w'), [
		path.resolve('/w/A.java'),
	]);
	assert.deepEqual(javacVerboseInputs('[構文解析開始 SimpleFileObject[/w/A.java]]', '/w'), []);

	// javac 27 with --release 8 and 11 loads .sig files from ct.sym, and javac 8 loads classes from ct.sym.
	const jdkClasses = [
		'[loading /8/java.base/java/lang/Object.sig]',
		'[loading /89A/java.base/java/io/Serializable.sig]',
		'[loading /B/java.base/module-info.sig]',
		'[loading ZipFileIndexFileObject[/opt/jdk8/lib/ct.sym(META-INF/sym/rt.jar/java/lang/Object.class)]]',
		'[loading ZipFileIndexFileObject[/opt/jdk8/jre/lib/rt.jar(java/lang/Object.class)]]',
	].join('\n');
	assert.deepEqual(javacVerboseInputs(jdkClasses, '/w'), [
		path.resolve('/opt/jdk8/lib/ct.sym'),
		path.resolve('/opt/jdk8/jre/lib/rt.jar'),
	]);
});

test('the -verbose lines leave the compiler output, and the other lines stay', () => {
	const output = `${verboseLinux}\nsrc/A.java:3: warning: [rawtypes] found raw type: List\n    [x] = 1;\n`;
	const split = splitVerboseLines(output);
	assert.equal(split.verbose.length, 12);
	assert.equal(split.other, 'src/A.java:3: warning: [rawtypes] found raw type: List\n    [x] = 1;\n');
	assert.deepEqual(splitVerboseLines('[total 1ms]\r\nNote: x\r\n'), {
		verbose: ['[total 1ms]'],
		other: 'Note: x\r\n',
	});
});

test('the compile moves its -verbose lines into the input listing, also when javac fails', async () => {
	const folder = temporaryFolder();
	try {
		const run = (args: readonly string[], result: { returnCode: number; stdout: string; stderr: string }) =>
			runJavac({
				arguments: args,
				temporaryDirectory: folder,
				execute: async (executed) => {
					assert.deepEqual(executed, args);
					if (result.returnCode !== 0) {
						throw new ToolExitError('Toolchain exited with code 1', 1, result.stdout, result.stderr);
					}
					return result;
				},
				log: () => undefined,
				cancellationToken: neverCancelled,
			});
		const listingFile = path.join(folder, 'javac-inputs.txt');
		const passed = await run(['-verbose', 'A.java'], {
			returnCode: 0,
			stdout: '',
			stderr: `${verboseLinux}\nNote: A.java uses unchecked or unsafe operations.\n`,
		});
		assert.equal(passed.stderr, 'Note: A.java uses unchecked or unsafe operations.\n');
		assert.equal(fs.readFileSync(listingFile, 'utf8'), verboseLinux);

		await assert.rejects(
			run(['-verbose', 'A.java'], {
				returnCode: 1,
				stdout: '',
				stderr: '[parsing started SimpleFileObject[/w/A.java]]\nA.java:1: error: x\n[total 1ms]\n',
			}),
			(error: unknown) =>
				error instanceof ToolExitError && error.stderr === 'A.java:1: error: x\n' && error.returnCode === 1,
		);

		// Without -verbose, the output does not change.
		fs.rmSync(listingFile);
		const plain = await run(['A.java'], { returnCode: 0, stdout: '', stderr: '[total 1ms]\n' });
		assert.equal(plain.stderr, '[total 1ms]\n');
		assert.equal(fs.existsSync(listingFile), false);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

test('javap comes from beside javac, the linked javac, the Oracle JDK folders, JAVA_HOME, or PATH', () => {
	const root = temporaryFolder();
	try {
		const name = 'javap.exe';
		const environment = (values: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: '', ...values });
		// A JDK: javap is beside javac.
		const jdk = path.join(root, 'jdk-21', 'bin');
		const javac = touch(path.join(jdk, 'javac.exe'));
		touch(path.join(jdk, name));
		assert.equal(findJavap(javac, environment({}), 'win32'), path.join(jdk, name));

		// The Oracle launcher folder: the newest JDK of the Oracle installer.
		const programFiles = path.join(root, 'Program Files');
		const launcher = touch(path.join(programFiles, 'Common Files', 'Oracle', 'Java', 'javapath', 'javac.exe'));
		for (const version of ['jdk-21.0.2', 'jdk-27.0.1.0.2', 'jdk1.8.0_392', 'jre-27']) {
			touch(path.join(programFiles, 'Java', version, 'bin', name));
		}
		const javaHome = path.join(root, 'home');
		touch(path.join(javaHome, 'bin', name));
		assert.equal(
			findJavap(launcher, environment({ ProgramFiles: programFiles, JAVA_HOME: javaHome }), 'win32'),
			path.join(programFiles, 'Java', 'jdk-27.0.1.0.2', 'bin', name),
		);
		// Only the Oracle launcher folder selects the newest Oracle JDK.
		const lone = touch(path.join(root, 'lone', 'javac.exe'));
		assert.equal(
			findJavap(lone, environment({ ProgramFiles: programFiles, java_home: javaHome }), 'win32'),
			path.join(javaHome, 'bin', name),
		);
		const onPath = path.join(root, 'path');
		touch(path.join(onPath, name));
		assert.equal(findJavap(lone, environment({ PATH: onPath }), 'win32'), path.join(onPath, name));
		assert.equal(findJavap(lone, environment({}), 'win32'), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('javap comes from the folder of the file that a javac link names', { skip: process.platform === 'win32' }, () => {
	const root = temporaryFolder();
	try {
		const jdk = path.join(root, 'jvm', 'bin');
		touch(path.join(jdk, 'javac'));
		touch(path.join(jdk, 'javap'));
		// As /usr/bin/javac links to /etc/alternatives/javac, which links to the JDK.
		fs.mkdirSync(path.join(root, 'bin'));
		fs.symlinkSync(path.join(jdk, 'javac'), path.join(root, 'bin', 'javac'));
		assert.equal(findJavap(path.join(root, 'bin', 'javac'), { PATH: '' }, 'linux'), path.join(jdk, 'javap'));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('javac diagnostics give the caret column, also after tabs, and the indented details', () => {
	// javac 21 on Linux. The caret line copies the tabs of the source line.
	const output = [
		'src/p/Bad.java:6: warning: [rawtypes] found raw type: List',
		'\tstatic int f(List raw) {',
		'\t             ^',
		'  missing type arguments for generic class List<E>',
		'  where E is a type-variable:',
		'    E extends Object declared in interface List',
		'src/p/Bad.java:8: error: incompatible types: String cannot be converted to int',
		'\t\tint x = "text";',
		'\t\t        ^',
		'src/p/Bad.java:9: error: cannot find symbol',
		'\t\treturn Other.value() + missing;',
		'\t\t                       ^',
		'  symbol:   variable missing',
		'  location: class Bad',
		'src/p/Other.java:2: error: cannot find symbol',
		'class Other { static int value() { return undefined; } }',
		'                                          ^',
		'  symbol:   variable undefined',
		'  location: class Other',
		'Note: src/p/Bad.java uses unchecked or unsafe operations.',
		'3 errors',
		'1 warning',
	].join('\n');
	const source = path.resolve('/w/src/p/Bad.java');
	const diagnostics = parseJavacDiagnostics(output, fileUri(source), path.resolve('/w'));
	assert.deepEqual(
		diagnostics.map((diagnostic) => [
			diagnostic.uri.fsPath,
			diagnostic.line,
			diagnostic.column,
			diagnostic.severity,
			diagnostic.message,
		]),
		[
			[
				source,
				5,
				14,
				'warning',
				'[rawtypes] found raw type: List\nmissing type arguments for generic class List<E>\nwhere E is a type-variable:\nE extends Object declared in interface List',
			],
			[source, 7, 10, 'error', 'incompatible types: String cannot be converted to int'],
			[source, 8, 25, 'error', 'cannot find symbol\nsymbol:   variable missing\nlocation: class Bad'],
			[
				path.resolve('/w/src/p/Other.java'),
				1,
				42,
				'error',
				'cannot find symbol\nsymbol:   variable undefined\nlocation: class Other',
			],
		],
	);
	// javac 27 on Windows names the source with its drive and ends its lines with \r\n.
	const windows = parseJavacDiagnostics(
		"C:\\w\\A.java:3: error: ';' expected\r\n        int x = 1\r\n                 ^\r\n1 error\r\n",
		fileUri('C:\\w\\A.java'),
		'C:\\w',
	);
	assert.deepEqual(
		windows.map((diagnostic) => [diagnostic.line, diagnostic.column, diagnostic.message]),
		[[2, 17, "';' expected"]],
	);
	assert.deepEqual(
		parseJavacDiagnostics('error: invalid flag: -foo\nUsage: javac <options>', sourceUri(source), '/w'),
		[],
	);
});
