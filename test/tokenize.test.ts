import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandLineSyntaxError, tokenizePosix, tokenizeWindows } from '../src/tokenize.js';

test('tokenizes POSIX quoting and escaping', () => {
	assert.deepEqual(
		tokenizePosix(`-DNAME='hello world' -I"/path with spaces" escaped\\ value ""`),
		['-DNAME=hello world', '-I/path with spaces', 'escaped value', ''],
	);
	assert.throws(() => tokenizePosix(`-DVALUE='unfinished`), CommandLineSyntaxError);
});

test('tokenizes Windows quoting and backslashes', () => {
	assert.deepEqual(
		tokenizeWindows(String.raw`/DNAME="hello world" "/Ipath with spaces" plain`),
		['/DNAME=hello world', '/Ipath with spaces', 'plain'],
	);
	assert.deepEqual(tokenizeWindows(String.raw`"a\\\"b" c`), [String.raw`a\"b`, 'c']);
});
