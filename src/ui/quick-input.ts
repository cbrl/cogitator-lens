import { window } from 'vscode';
import type { QuickPickItem, QuickPickOptions } from 'vscode';

export async function pickFrom<T>(
	items: readonly T[],
	mapper: (item: T) => QuickPickItem,
	options: QuickPickOptions,
): Promise<T | undefined> {
	const choice = await window.showQuickPick(
		items.map((value) => ({ ...mapper(value), value })),
		options,
	);
	return choice?.value;
}

export async function inputStringArray(title: string, value: readonly string[]): Promise<string[] | undefined> {
	const result = [...value];
	while (true) {
		const choice = await window.showQuickPick(
			[
				{ label: '$(check) Done', action: 'done' as const },
				{ label: '$(add) Add argument', action: 'add' as const },
				...result.map((argument, index) => ({
					label: argument || '(empty argument)',
					description: `Argument ${index + 1}`,
					action: 'item' as const,
					index,
				})),
			],
			{
				title,
				placeHolder: 'Add, edit, remove, or reorder compiler arguments',
				matchOnDescription: true,
			},
		);
		if (!choice) {
			return undefined;
		}
		if (choice.action === 'done') {
			return result;
		}
		if (choice.action === 'add') {
			const argument = await window.showInputBox({
				title: `${title}: Add argument`,
				prompt: 'This value is passed as one compiler argument',
			});
			if (argument !== undefined) {
				result.push(argument);
			}
			continue;
		}
		const index = choice.index;
		const action = await window.showQuickPick(
			[
				{ label: '$(edit) Edit', action: 'edit' as const },
				...(index > 0 ? [{ label: '$(arrow-up) Move up', action: 'up' as const }] : []),
				...(index < result.length - 1 ? [{ label: '$(arrow-down) Move down', action: 'down' as const }] : []),
				{ label: '$(trash) Remove', action: 'remove' as const },
			],
			{ title: `${title}: ${result[index] || '(empty argument)'}` },
		);
		switch (action?.action) {
			case 'edit': {
				const argument = await window.showInputBox({
					title: `${title}: Edit argument`,
					value: result[index],
				});
				if (argument !== undefined) {
					result[index] = argument;
				}
				break;
			}
			case 'up':
				[result[index - 1], result[index]] = [result[index], result[index - 1]];
				break;
			case 'down':
				[result[index], result[index + 1]] = [result[index + 1], result[index]];
				break;
			case 'remove':
				result.splice(index, 1);
				break;
		}
	}
}

export async function inputStringRecord(
	title: string,
	value: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
	const result = { ...value };
	while (true) {
		const entries = Object.entries(result);
		const choice = await window.showQuickPick(
			[
				{ label: '$(check) Done', action: 'done' as const },
				{ label: '$(add) Add variable', action: 'add' as const },
				...entries.map(([name, variableValue]) => ({
					label: name,
					description: variableValue,
					action: 'item' as const,
					name,
				})),
			],
			{
				title,
				placeHolder: 'Add, edit, or remove environment variables',
				matchOnDescription: true,
			},
		);
		if (!choice) {
			return undefined;
		}
		if (choice.action === 'done') {
			return result;
		}
		if (choice.action === 'add') {
			const entry = await inputEnvironmentEntry(title, result);
			if (entry) {
				result[entry.name] = entry.value;
			}
			continue;
		}
		const action = await window.showQuickPick(
			[
				{ label: '$(edit) Edit', action: 'edit' as const },
				{ label: '$(trash) Remove', action: 'remove' as const },
			],
			{ title: `${title}: ${choice.name}` },
		);
		if (action?.action === 'remove') {
			delete result[choice.name];
		} else if (action?.action === 'edit') {
			const entry = await inputEnvironmentEntry(title, result, choice.name);
			if (entry) {
				delete result[choice.name];
				result[entry.name] = entry.value;
			}
		}
	}
}

export async function inputEnvironmentEntry(
	title: string,
	existing: Readonly<Record<string, string>>,
	previousName?: string,
): Promise<{ name: string; value: string } | undefined> {
	const name = (
		await window.showInputBox({
			title: `${title}: Variable name`,
			value: previousName,
			validateInput: (candidate) => {
				const normalized = candidate.trim();
				if (!normalized) {
					return 'A variable name is required';
				}
				return normalized !== previousName && Object.hasOwn(existing, normalized)
					? 'A variable with this name already exists'
					: undefined;
			},
		})
	)?.trim();
	if (!name) {
		return undefined;
	}
	const variableValue = await window.showInputBox({
		title: `${title}: ${name}`,
		prompt: 'Environment variable value',
		value: previousName ? existing[previousName] : '',
	});
	return variableValue === undefined ? undefined : { name, value: variableValue };
}
