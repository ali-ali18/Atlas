import assert from "node:assert/strict";
import test from "node:test";
import { renderChangelog } from "./changelog.mjs";

test("agrupa por tipo, em pt-BR, com escopo em negrito", () => {
	const md = renderChangelog(
		["fix(chat): volta do segundo plano", "feat(ui): avatar novo", "feat!: contrato novo", "ci: GitHub Actions", "Merge branch x", "mensagem solta", "chore: limpeza"],
		{ title: "v0.1.0-beta" },
	);
	assert.match(md, /^## v0\.1\.0-beta/);
	assert.ok(md.indexOf("### Novidades") < md.indexOf("### Correções"));
	assert.match(md, /### Novidades\n- \*\*ui:\*\* avatar novo\n- contrato novo \(mudança incompatível\)/);
	assert.match(md, /### Correções\n- \*\*chat:\*\* volta do segundo plano/);
	assert.match(md, /### Outras mudanças\n- mensagem solta/);
	assert.doesNotMatch(md, /Merge branch/);
});

test("sem commits devolve aviso", () => {
	assert.match(renderChangelog([], { title: "v1" }), /Sem mudanças registradas/);
});
