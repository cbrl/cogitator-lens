import type { ToolchainHost } from '../src/toolchains/toolchain-backend.js';

export const testToolchainHost: ToolchainHost = {
	log() {},
	parseDiagnostics: () => [],
};
