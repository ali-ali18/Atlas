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

test("nav tem as onze seções, busca e conteúdo à direita; Avançado por último", () => {
	const html = render();
	assert.match(html, /aria-label="Buscar nas configurações"/);
	const labels = ["Conta", "Geral", "Provedores e planos", "Bots", "Notificações", "Computador", "Conexões", "Cofre", "Uso", "Avançado"];
	for (const label of labels) assert.match(html, new RegExp(`<span class="truncate">${label}</span>`));
	const positions = labels.map((label) => html.indexOf(`<span class="truncate">${label}</span>`));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions, "ordem Geral → Avançado");
	assert.match(html, /<h2>Titulo<\/h2>/);
	assert.match(html, /conteudo:11/);
	assert.doesNotMatch(html, />Personalização</, "sem grupos na nav");
	assert.match(html, /md:w-\[198px\]/, "nav de 198px");
});

test("não há mais Rotinas, Conectores nem Provedores na nav (viraram itens dentro das seções)", () => {
	const html = render();
	for (const label of ["Rotinas", "Conectores", "Provedores", "Modelos", "JEV", "Execução"]) {
		assert.doesNotMatch(html, new RegExp(`<span class="truncate">${label}</span>`));
	}
});

test("quem não é dono continua vendo as onze seções (só os itens do ChatGPT somem)", () => {
	const html = render({ hidden: hiddenSettingsItems({ isOwner: false }) });
	assert.match(html, /conteudo:11/);
});

/** HTML do botão da nav com esse rótulo. */
function navButton(html: string, label: string): string {
	const button = html.split("<button").find((chunk) => chunk.includes(`<span class="truncate">${label}</span>`));
	assert.ok(button, `botão ${label} não encontrado`);
	return button;
}

test("seção ativa leva aria-current e as outras não", () => {
	const html = render({ section: "avancado" });
	assert.match(navButton(html, "Avançado"), /aria-current="page"/);
	assert.doesNotMatch(navButton(html, "Geral"), /aria-current/);
	assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test("busca por configuração filtra a nav e o conteúdo recebe o filtro", () => {
	const html = render({ initialQuery: "tema" });
	assert.match(html, /<span class="truncate">Geral<\/span>/);
	assert.doesNotMatch(html, /<span class="truncate">Avançado<\/span>/);
	assert.match(html, /conteudo:1/);
});

test("busca por algo de Avançado leva à seção Avançado", () => {
	const html = render({ initialQuery: "limite de passos" });
	assert.match(html, /<span class="truncate">Avançado<\/span>/);
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
	assert.equal(buttons.length, 11);
	for (const button of buttons) assert.match(button, /data-nav-icon/, "botão da nav sem ícone");
	assert.match(navButton(html, "Uso"), /data-nav-icon/);
});
