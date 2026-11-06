/**
 * Names the register family of a machine register, so `eax`, `ax`, and `al` all find `rax`. A
 * name that is not a register gives nothing. Names are case-insensitive, and an AT&T `%` prefix is
 * removed first.
 */
export function registerFamily(name: string): string | undefined {
	const register = name.replace(/^%/, '').toLowerCase();
	return x86Families.get(register) ?? aarch64Family(register);
}

const x86Families = new Map<string, string>();

function addFamily(family: string, names: readonly string[]): void {
	for (const name of names) {
		x86Families.set(name, family);
	}
}

for (const letter of ['a', 'b', 'c', 'd']) {
	addFamily(`r${letter}x`, [`r${letter}x`, `e${letter}x`, `${letter}x`, `${letter}l`, `${letter}h`]);
}
for (const base of ['si', 'di', 'bp', 'sp']) {
	addFamily(`r${base}`, [`r${base}`, `e${base}`, base, `${base}l`]);
}
for (let index = 8; index <= 31; index++) {
	addFamily(`r${index}`, [`r${index}`, `r${index}d`, `r${index}w`, `r${index}b`, `r${index}l`]);
}
for (let index = 0; index <= 31; index++) {
	addFamily(`xmm${index}`, [`xmm${index}`, `ymm${index}`, `zmm${index}`]);
}
addFamily('rip', ['rip', 'eip', 'ip']);
for (let index = 0; index <= 7; index++) {
	addFamily(`k${index}`, [`k${index}`]);
	addFamily(`st${index}`, [`st${index}`, `st(${index})`]);
	addFamily(`mm${index}`, [`mm${index}`]);
}

/** AArch64: `x0` and `w0` share a family, and so do `v0`, `q0`, `d0`, `s0`, `h0`, and `b0`. */
function aarch64Family(register: string): string | undefined {
	const general = /^[xw]([0-9]|[12][0-9]|30)$/.exec(register);
	if (general) {
		return `x${general[1]}`;
	}
	if (register === 'sp' || register === 'wsp') {
		return 'sp';
	}
	if (register === 'xzr' || register === 'wzr') {
		return 'xzr';
	}
	const vector = /^[vqdshb]([0-9]|[12][0-9]|3[01])$/.exec(register);
	return vector ? `v${vector[1]}` : undefined;
}
