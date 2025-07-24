import { window } from 'vscode';

export const logChannel = window.createOutputChannel('Cogitator Lens', { log: true });

export function logAndShowMessage(level: 'info' | 'warn' | 'error', message: string) {
	switch (level) {
		case 'info':
			window.showInformationMessage(message);
			logChannel.info(message);
			break;
		case 'warn':
			window.showWarningMessage(message);
			logChannel.warn(message);
			break;
		case 'error':
			window.showErrorMessage(message);
			logChannel.error(message);
			break;
	}
}

export function logAndShowInfo(message: string) {
	logAndShowMessage('info', message);
}

export function logAndShowWarning(message: string) {
	logAndShowMessage('warn', message);
}

export function logAndShowError(message: string) {
	logAndShowMessage('error', message);
}
