import test from "node:test";
import assert from "node:assert/strict";
import { parseAxYaml } from "./ax-prune.mjs";
import { DIFF_MAX_LINES, diffAxTrees, flattenForDiff } from "./ax-diff.mjs";

const flat = (yaml) => flattenForDiff(parseAxYaml(yaml).byRef);

const BEFORE = `- main [ref=e1]:
  - button "Menu" [ref=e2]
  - textbox "Senha" [ref=e3]: segredo1
  - button "Curtir" [active] [ref=e4]
  - paragraph [ref=e5]: Olá`;

test("sem mudança relevante: nada (foco muda e não conta)", () => {
	const after = BEFORE.replace('"Curtir" [active]', '"Curtir"');
	assert.deepEqual(diffAxTrees(flat(BEFORE), flat(after)), []);
});

test("novo item, item que sumiu e mudança de estado, por ref", () => {
	const after = `- main [ref=e1]:
  - button "Menu" [expanded] [ref=e2]
  - textbox "Senha" [ref=e3]: segredo1
  - button "Curtir" [ref=e4]
  - dialog "Entrar" [ref=e9]:
    - button "Fechar" [ref=e10]`;
	const lines = diffAxTrees(flat(BEFORE), flat(after));
	assert.deepEqual(lines, [
		'+ dialog "Entrar"',
		'- paragraph: "Olá"',
		'~ button "Menu" [a2] [expanded] estado: — → expanded',
	]);
});

test("filho de um nó novo não repete: só o mais alto com significado", () => {
	const after = `${BEFORE}\n  - article "Resposta" [ref=e20]:\n    - button "Responder" [ref=e21]\n    - paragraph [ref=e22]: texto novo`;
	const lines = diffAxTrees(flat(BEFORE), flat(after));
	assert.deepEqual(lines, ['+ article "Resposta"']);
});

test("nunca vaza valor de campo, nem mudando", () => {
	const after = BEFORE.replace("segredo1", "segredo2");
	const lines = diffAxTrees(flat(BEFORE), flat(after));
	assert.deepEqual(lines, []);
	const added = `${BEFORE}\n  - textbox "Token" [ref=e30]: abc123`;
	assert.doesNotMatch(diffAxTrees(flat(BEFORE), flat(added)).join("\n"), /abc123/);
});

test("teto de linhas: 5.000 itens novos viram 25 linhas + contagem", () => {
	const items = Array.from({ length: 5000 }, (_, i) => `  - button "Item ${i}" [ref=e${100 + i}]`).join("\n");
	const lines = diffAxTrees(flat(BEFORE), flat(`${BEFORE}\n${items}`));
	assert.equal(lines.length, DIFF_MAX_LINES);
	assert.match(lines.at(-1), /^… \+4976 mudanças$/);
});

test("sem um dos lados (primeiro snapshot): vazio", () => {
	assert.deepEqual(diffAxTrees(null, flat(BEFORE)), []);
});
