import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, clampSnapshotPage, describeElement, formatElementLine, nameOf, roleOf } from "./snapshot.mjs";

const base = { tag: "input", type: "text", roleAttr: "", ariaLabel: "", labelledBy: "", label: "", text: "", placeholder: "", title: "", alt: "", nameAttr: "", inViewport: true };

test("roleOf: tag/type/role explícito", () => {
	assert.equal(roleOf({ ...base, tag: "a" }), "link");
	assert.equal(roleOf({ ...base, tag: "select" }), "combobox");
	assert.equal(roleOf({ ...base, type: "checkbox" }), "checkbox");
	assert.equal(roleOf({ ...base, type: "submit" }), "button");
	assert.equal(roleOf({ ...base, type: "date" }), "textbox");
	assert.equal(roleOf({ ...base, autocomplete: true }), "combobox");
	assert.equal(roleOf({ ...base, tag: "div", roleAttr: "tab" }), "tab");
	assert.equal(roleOf({ ...base, tag: "div", editable: true }), "textbox");
});

test("nameOf: aria-label > label > texto > placeholder > name", () => {
	assert.equal(nameOf({ ...base, ariaLabel: "Buscar", label: "Outro", placeholder: "p" }), "Buscar");
	assert.equal(nameOf({ ...base, label: "Cliente", placeholder: "Digite" }), "Cliente");
	assert.equal(nameOf({ ...base, tag: "button", text: "Salvar" }), "Salvar");
	assert.equal(nameOf({ ...base, placeholder: "Digite o nome" }), "Digite o nome");
	assert.equal(nameOf({ ...base, nameAttr: "cliente_id" }), "cliente_id");
	assert.equal(nameOf({ ...base, type: "submit", value: "Enviar" }), "Enviar");
});

test("senha nunca aparece: sem value e com aviso", () => {
	const el = describeElement({ ref: "e1", ...base, type: "password", label: "Senha", secret: true, value: "hunter2" });
	assert.equal(el.value, undefined);
	assert.match(formatElementLine(el), /nunca preencha/);
	assert.doesNotMatch(formatElementLine(el), /value=/);
	assert.doesNotMatch(formatElementLine(el), /hunter2/);
});

test("formatElementLine: formulário de proposta (select, data, autocomplete, checkbox, link)", () => {
	const lines = [
		{ ref: "e1", ...base, label: "Cliente", autocomplete: true, value: "", required: true, landmark: "form" },
		{ ref: "e2", ...base, tag: "select", label: "Vendedor", value: "Alisson", options: [{ label: "Alisson" }, { label: "Bruno" }], optionCount: 20, landmark: "form" },
		{ ref: "e3", ...base, type: "date", label: "Data", value: "2026-09-30" },
		{ ref: "e4", ...base, type: "checkbox", label: "Enviar e-mail", checked: false },
		{ ref: "e5", ...base, tag: "a", text: "Incluir item", href: "#add", inViewport: false },
		{ ref: "e6", ...base, tag: "button", text: "Salvar", disabled: true },
	]
		.map(describeElement)
		.map(formatElementLine);
	assert.equal(lines[0], '[e1] combobox "Cliente" autocomplete required (form)');
	assert.equal(lines[1], '[e2] combobox "Vendedor" value="Alisson" options=[Alisson|Bruno|+18] (form)');
	assert.equal(lines[2], '[e3] textbox "Data" value="2026-09-30"');
	assert.equal(lines[3], '[e4] checkbox "Enviar e-mail" unchecked');
	assert.equal(lines[4], "[e5] link \"Incluir item\" → #add ↓fora da janela");
	assert.equal(lines[5], '[e6] button "Salvar" disabled');
});

test("buildSnapshot: pagina em blocos de no máximo 80 e sinaliza o resto", () => {
	const raws = Array.from({ length: 130 }, (_, i) => ({ ref: `e${i + 1}`, ...base, tag: "button", text: `B${i + 1}` }));
	const first = buildSnapshot({ url: "u", title: "t", raws, scroll: { scrollY: 0 } });
	assert.equal(first.elements.length, 80);
	assert.equal(first.total, 130);
	assert.equal(first.nextOffset, 80);
	assert.equal(first.scrollY, 0);
	const second = buildSnapshot({ url: "u", title: "t", raws, page: { offset: first.nextOffset, limit: 500 } });
	assert.equal(second.elements.length, 50);
	assert.equal(second.nextOffset, null);
	assert.equal(second.elements[0].ref, "e81");
	assert.deepEqual(clampSnapshotPage({ offset: -1, limit: 500 }), { offset: 0, limit: 80 });
});

test("iframe e nomes longos", () => {
	const el = describeElement({ ref: "e9", ...base, tag: "button", text: "x".repeat(300), inFrame: "pagamento" });
	assert.equal(el.name.length, 80);
	assert.match(formatElementLine(el), /\{iframe pagamento\}/);
});
