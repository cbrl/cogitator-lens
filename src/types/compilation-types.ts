/**
 * Compilation-related type definitions
 */

import { Uri } from 'vscode';

export type CompilationInfo = {
	compilerName: string;
	defines: string[];
	includes: string[];
	args: string[];
};

export type CompilationInfoChange = [Uri, CompilationInfo];
