import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hiddenSettingsItems, type SettingsSectionId } from "./settings-registry";
import { SettingsShell } from "./settings-shell";

Object.assign(globalThis, { React });

function render(options: { section?: SettingsSectionId; initialQuery?: string; hidden?: ReadonlySet<string> } = {}) {
	return renderToStaticMarkup(
		<SettingsShell
			header={<h2>Titulo</h2>}
			hiddenItems={options.hidden}
			initialQuery={options.initialQuery}
			onSectionChange={() => {}}
			section={options.section ?? "geral"}
		>
			{({ search }) => <p>conteudo:{search.entries.length}</p>}
		</SettingsShell>,
	);
}

test("nav tem as catorze seções, busca e conteúdo à direita; Avançado por último", () => {
	const html = render();
	assert.match(html, /aria-label="Buscar nas configurações"/);
	const labels = ["Conta", "Geral", "Notificações", "Bots", "Modelos e contexto", "Provedores e chaves", "Computador", "Conexões", "Cofre", "Uso e custos", "Execução e limites", "Revisão automática", "Diagnóstico"];
	for (const label of labels) assert.match(html, new RegExp(`<span class="truncate">${label}</span>`));
	const positions = labels.map((label) => html.indexOf(`<span class="truncate">${label}</span>`));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions, "ordem Geral → Avançado");
	assert.match(html, /<h2>Titulo<\/h2>/);
	assert.match(html, /conteudo:14/);
	for (const group of ["Básico", "Bots e modelos", "Ferramentas", "Controle"]) assert.match(html, new RegExp(`data-nav-group="">${group}</p>`), `bloco ${group}`);
	assert.match(html, /md:w-\[198px\]/, "nav de 198px");
});

test("não há mais Rotinas, Conectores nem Provedores na nav (viraram itens dentro das seções)", () => {
	const html = render();
	for (const label of ["Rotinas", "Conectores", "Provedores", "Modelos", "JEV", "Execução", "Avançado", "Técnico"]) {
		assert.doesNotMatch(html, new RegExp(`<span class="truncate">${label}</span>`));
	}
});

test("quem não é dono continua vendo as catorze seções (só os itens do ChatGPT somem)", () => {
	const html = render({ hidden: hiddenSettingsItems({ isOwner: false }) });
	assert.match(html, /conteudo:14/);
});

/** HTML do botão da nav com esse rótulo. */
function navButton(html: string, label: string): string {
	const button = html.split("<button").find((chunk) => chunk.includes(`<span class="truncate">${label}</span>`));
	assert.ok(button, `botão ${label} não encontrado`);
	return button;
}

test("seção ativa leva aria-current e as outras não", () => {
	const html = render({ section: "revisao" });
	assert.match(navButton(html, "Revisão automática"), /aria-current="page"/);
	assert.doesNotMatch(navButton(html, "Geral"), /aria-current/);
	assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test("busca por configuração filtra a nav e o conteúdo recebe o filtro", () => {
	const html = render({ initialQuery: "tema" });
	assert.match(html, /<span class="truncate">Geral<\/span>/);
	assert.doesNotMatch(html, /<span class="truncate">Revisão automática<\/span>/);
	assert.match(html, /conteudo:1/);
});

test("busca por limite de passos leva à seção Execução e limites", () => {
	const html = render({ initialQuery: "limite de passos" });
	assert.match(html, /<span class="truncate">Execução e limites<\/span>/);
	assert.doesNotMatch(html, /<span class="truncate">Geral<\/span>/);
});

test("busca sem resultado mostra Nada encontrado", () => {
	const html = render({ initialQuery: "zzzz" });
	assert.match(html, /Nada encontrado/);
	assert.doesNotMatch(html, /data-nav-item/);
});

test("mobile troca a nav por um dropdown com rótulo acessível", () => {
	const html = render();
	assert.match(html, /aria-label="Seção das configurações"/);
});

test("toda entrada da nav tem ícone, para o texto alinhar", () => {
	const html = render();
	const buttons = html.split("<button").filter((chunk) => chunk.includes("data-nav-item"));
	assert.equal(buttons.length, 14);
	for (const button of buttons) assert.match(button, /data-nav-icon/, "botão da nav sem ícone");
	assert.match(navButton(html, "Uso e custos"), /data-nav-icon/);
});
