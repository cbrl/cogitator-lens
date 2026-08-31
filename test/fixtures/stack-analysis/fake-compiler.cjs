const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const source = args.at(-1);

if (args.includes('-M')) {
	if (args.includes('--dependency-fail')) {
		process.exitCode = 2;
	} else {
		const dependencyOutput = args[args.indexOf('-MF') + 1];
		const dependencySource = source.replace(/([ #:$\\])/g, '\\$1');
		fs.writeFileSync(dependencyOutput, `output.o: ${dependencySource}\n`);
	}
	return;
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
if (args.includes('--fail')) {
	process.stderr.write(`${source}:1:1: error: expected fake failure\n`);
	process.exitCode = 2;
	return;
}
fs.writeFileSync(output, 'object');
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
