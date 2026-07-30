import { window } from 'vscode';

export const logChannel = window.createOutputChannel('Cogitator Lens', { log: true });
