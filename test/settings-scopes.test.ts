import assert from 'node:assert/strict';
import test from 'node:test';
import {
	definesArtifactOption,
	definingScope,
	resourceScopes,
	windowScopes,
	withArtifactOption,
	withListEntry,
	withMapEntry,
	withoutListEntry,
} from '../src/services/settings-scopes.js';

test('the defining scope is the most specific one whose value matches', () => {
	const scopes = { workspaceFolder: { a: 1 }, workspace: { b: 1 }, user: { a: 1, b: 1 } };
	const defines = (key: string) => (value: object) => Object.hasOwn(value, key);
	assert.equal(definingScope(scopes, defines('a'), resourceScopes), 'workspaceFolder');
	assert.equal(definingScope(scopes, defines('a'), windowScopes), 'user');
	assert.equal(definingScope(scopes, defines('b'), resourceScopes), 'workspace');
	assert.equal(definingScope(scopes, defines('c'), resourceScopes), undefined);
});

test('setting one artifact option keeps the scope value and drops the ID it replaced', () => {
	const workspace = { assembly: { labels: true, intel: true }, ast: { showSystemDeclarations: true } };
	assert.equal(definesArtifactOption(workspace, 'assembly', ['showUnusedLabels', 'labels']), true);
	assert.equal(definesArtifactOption(workspace, 'assembly', ['showDirectives', 'directives']), false);
	assert.deepEqual(withArtifactOption(workspace, 'assembly', 'showUnusedLabels', true, ['labels']), {
		assembly: { intel: true, showUnusedLabels: true },
		ast: { showSystemDeclarations: true },
	});
	assert.deepEqual(withArtifactOption(undefined, 'assembly', 'trim', true), { assembly: { trim: true } });
});

test('list entries are replaced by key or appended, and map entries can be renamed', () => {
	const toolchains = [
		{ displayName: 'GCC', executable: 'gcc' },
		{ displayName: 'Clang', executable: 'clang' },
	];
	assert.deepEqual(withListEntry(toolchains, 'displayName', { displayName: 'GCC', executable: 'gcc-14' }), [
		{ displayName: 'GCC', executable: 'gcc-14' },
		{ displayName: 'Clang', executable: 'clang' },
	]);
	assert.deepEqual(withListEntry(undefined, 'id', { id: 'a' }), [{ id: 'a' }]);
	assert.deepEqual(withoutListEntry(toolchains, 'displayName', 'GCC'), [
		{ displayName: 'Clang', executable: 'clang' },
	]);
	assert.deepEqual(withMapEntry({ old: 1, other: 2 }, 'new', 3, 'old'), { other: 2, new: 3 });
});
