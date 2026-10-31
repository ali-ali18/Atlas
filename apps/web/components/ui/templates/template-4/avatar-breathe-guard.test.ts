import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Só o avatar do chat aberto (cabeçalho e indicador de trabalho) respira. Lista, sidebar, painel e
// afins ficam parados: avatar que respira mantém o loop de quadros acordado (CPU em celular).
const WEB_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ALLOWED = new Set([
	"components/ui/templates/template-4/chat-thread/chat-thread.tsx",
	"components/ui/templates/template-4/chat-thread/working-indicator.tsx",
]);

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sources(full, out);
		else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
	}
	return out;
}

test("só o cabeçalho e o indicador do chat aberto ligam `breathe`", () => {
	const offenders: string[] = [];
	for (const dir of ["components", "app"]) {
		for (const file of sources(join(WEB_ROOT, dir))) {
			const rel = relative(WEB_ROOT, file).split("\\").join("/");
			// `breathe` ou `breathe={true}`; `breathe={false}` (boot) é desligar.
			const turnsOn = /\bbreathe(?![A-Za-z={])|\bbreathe=\{\s*true\s*\}/.test(readFileSync(file, "utf8"));
			if (turnsOn && !ALLOWED.has(rel)) offenders.push(rel);
		}
	}
	assert.deepEqual(offenders, []);
});

test("os dois avatares do chat aberto continuam respirando", () => {
	for (const rel of ALLOWED) assert.match(readFileSync(join(WEB_ROOT, rel), "utf8"), /\n\s*breathe\n/, rel);
});
