const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const source = args.at(-1);

if (process.env.COGLENS_FAKE_RUNS) {
	fs.appendFileSync(process.env.COGLENS_FAKE_RUNS, `${args.includes('-M') ? 'dependencies' : 'compile'}\n`);
}

function writeDependencies() {
	const dependencyOutput = args[args.indexOf('-MF') + 1];
	const dependencySource = source.replace(/([ #:$\\])/g, '\\$1');
	fs.writeFileSync(dependencyOutput, `output.o: ${dependencySource}\n`);
}

if (args.includes('-M')) {
	if (args.includes('--dependency-fail')) {
		process.exitCode = 2;
	} else {
		writeDependencies();
	}
	return;
}

// --no-inline-dependencies makes a compiler that ignores -MD, so the second run must list the inputs.
if (args.includes('-MD') && !args.includes('--no-inline-dependencies')) {
	writeDependencies();
}

const sourceDependenciesIndex = args.findIndex((argument) => argument.toLowerCase() === '/sourcedependencies');
if (sourceDependenciesIndex >= 0) {
	const dependencyOutput = args[sourceDependenciesIndex + 1];
	fs.writeFileSync(
		dependencyOutput,
		JSON.stringify({
			Version: '1.2',
			Data: { Source: source, Includes: [] },
		}),
	);
	return;
}

const outputIndex = args.indexOf('-o');
const clangOutputIndex = args.indexOf('/clang:-o');
const slashOutput = args.find((argument) => /^\/Fo.+/i.test(argument));
const output =
	outputIndex >= 0
		? args[outputIndex + 1]
		: clangOutputIndex >= 0
			? args[clangOutputIndex + 1]?.replace(/^\/clang:/, '')
			: slashOutput?.slice(3);
if (!output) {
	process.stderr.write('fake compiler did not receive an object output\n');
	process.exitCode = 2;
	return;
}
const stackOutput = output.replace(/\.[^.]+$/, '.su');
if (process.env.COGLENS_FAKE_TRACE) {
	fs.writeFileSync(process.env.COGLENS_FAKE_TRACE, path.dirname(output));
}
if (args.includes('--wait-for-cancellation')) {
	setTimeout(() => {}, 30_000);
	return;
}
// --delay=<milliseconds> makes a slow compile.
const delay = args.find((argument) => argument.startsWith('--delay='));
if (delay) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay.slice('--delay='.length)));
}
if (args.includes('--fail')) {
	process.stderr.write(`${source}:1:1: error: expected fake failure\n`);
	process.exitCode = 2;
	return;
}
if (args.includes('--warn')) {
	process.stderr.write(`${source}:1:5: warning: expected fake warning\n`);
}
// --echo-version writes the first version_<name> of the input, so a test sees which text the compile read.
if (args.includes('--echo-version')) {
	const text = fs.readFileSync(source, 'utf8');
	if (text.includes('FAIL')) {
		process.stderr.write(`${source}:2:1: error: expected fake failure of the text\n`);
		process.exitCode = 2;
		return;
	}
	fs.writeFileSync(output, /\bversion_\w+/.exec(text)?.[0] ?? 'no version');
	return;
}
// -filter-print-funcs=<name> prints pass dumps of that function, as LLVM does with -print-before-all and -print-after-all.
const passFilter = args.find((argument) => argument.startsWith('-filter-print-funcs='));
if (passFilter) {
	const name = passFilter.slice('-filter-print-funcs='.length);
	const define = `define i32 @${name}(i32 %0) {`;
	process.stderr.write(
		[
			`; *** IR Dump Before SROAPass on ${name} ***`,
			define,
			'  %2 = alloca i32, align 4',
			'  ret i32 %0',
			'}',
			`; *** IR Dump After SROAPass on ${name} ***`,
			define,
			'  ret i32 %0',
			'}',
			`; *** IR Dump Before EarlyCSEPass on ${name} ***`,
			define,
			'  ret i32 %0',
			'}',
			`; *** IR Dump After EarlyCSEPass on ${name} ***`,
			define,
			'  ret i32 %0',
			'}',
			'',
		].join('\n'),
	);
}
fs.writeFileSync(output, args.includes('--empty') ? '' : 'object');
if (args.includes('--missing-stack')) {
	return;
}
const lastLto = args.findLastIndex((argument) => /^(?:-flto(?:=.*)?|\/clang:-flto(?:=.*)?)$/i.test(argument));
const lastNoLto = args.findLastIndex((argument) => /^(?:-fno-lto|\/clang:-fno-lto)$/i.test(argument));
if (lastLto > lastNoLto) {
	return;
}
if (args.includes('--large-stack')) {
	const descriptor = fs.openSync(stackOutput, 'w');
	try {
		fs.ftruncateSync(descriptor, 50 * 1024 * 1024 + 1);
	} finally {
		fs.closeSync(descriptor);
	}
	return;
}
const location = args.includes('/clang:-fstack-usage')
	? `${source}:1:fake_function()`
	: `${source}:1:1:fake_function()`;
fs.writeFileSync(stackOutput, `${location}\t16\tstatic\n`);
