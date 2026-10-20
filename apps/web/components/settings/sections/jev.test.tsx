import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JEV_FEATURES, type AccountConfigV1, type EffectiveAccountConfig } from "@workspace/shared";
import { GroupsCoordinationRow, JevSettingsView } from "./jev";

Object.assign(globalThis, { React });

function effective(
	overrides: { mcp?: unknown; feature?: unknown; groups?: unknown } = {},
): EffectiveAccountConfig {
	const feature = overrides.feature ?? { value: "off", source: "default" };
	return {
		models: { reviewer: { value: undefined, source: "default" }, maintenance: { value: "openai/gpt-6-luna", source: "default" }, default: { value: "openai/gpt-4o-mini", source: "env" } },
		groups: { jevCoordination: overrides.groups ?? { value: false, source: "default" } },
		jev: {
			mcp: overrides.mcp ?? { value: "off", source: "default" },
			features: Object.fromEntries(JEV_FEATURES.map((f) => [f, feature])),
		},
	} as unknown as EffectiveAccountConfig;
}

function render(props: Partial<React.ComponentProps<typeof JevSettingsView>> = {}) {
	return renderToStaticMarkup(
		<JevSettingsView
			config={{ v: 1 }}
			effective={effective()}
			onChange={() => {}}
			status="idle"
			{...props}
		/>,
	);
}

test("Jev: revisão de conectores e decisões auxiliares, um dropdown cada, com rótulo acessível", () => {
	const html = render();
	assert.match(html, /for="settings-jev-mcp"[^>]*>Revisão de escritas em conectores</);
	assert.match(html, /id="settings-jev-mcp"/);
	assert.match(html, /for="settings-jev-all"[^>]*>Decisões auxiliares</);
	assert.match(html, /id="settings-jev-all"/);
	// Só os 2 gerais ficam à mostra; os 7 por recurso moram no recolhível (fechado).
	assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 2);
	assert.match(html, /<h3[^>]*>Revisões gerais<\/h3>/);
	assert.match(html, /Confere antes de criar, editar ou apagar algo num conector\./);
	assert.match(html, /Checagens extras enquanto o bot trabalha/);
	assert.match(html, /data-slot="jev-features-trigger"[^>]*>.*?Ajustar por recurso.*?7 ajustes finos/s);
});

test("Jev: o geral herdando mostra 'Herdar do servidor'; escolhido mostra o modo", () => {
	assert.match(render(), /Herdar do servidor/);
	const html = render({ config: { v: 1, jev: { all: "shadow" } } as AccountConfigV1 });
	assert.match(html, /id="settings-jev-all"[^>]*>.*?Observar/s);
});

test("Jev: revisão de conectores herdada mostra a origem; do usuário mostra o modo", () => {
	assert.match(render({ effective: effective({ mcp: { value: "shadow", source: "env" } }) }), /Herdar \(Observar\)/);
	const html = render({ effective: effective({ mcp: { value: "gate", source: "user" } }), config: { v: 1, jev: { mcp: "gate" } }, isVisible: (id) => id === "jev.mcp" });
	assert.match(html, /Bloquear/);
	assert.doesNotMatch(html.replace(/(class|style)="[^"]*"/g, ""), /Herdar: padrão/);
});

test("Jev: os 7 recursos ficam recolhidos em 'Ajustar por recurso' (fechado por padrão)", () => {
	const html = render();
	for (const id of ["intent", "tools", "verify", "blockpage", "delegate", "stuck"]) {
		assert.doesNotMatch(html, new RegExp(`id="settings-jev-${id}"`), `${id} não deve aparecer fechado`);
	}
	assert.match(html, /aria-expanded="false"/);
});

test("Jev: busca por um recurso abre o grupo só com ele, com 'Herdar' do geral", () => {
	const html = render({
		config: { v: 1, jev: { all: "shadow" } } as AccountConfigV1,
		effective: effective({ feature: { value: "shadow", source: "user" } }),
		isVisible: (id) => id === "jev.travamento",
	});
	assert.match(html, /for="settings-jev-stuck"[^>]*>Travamento</);
	assert.match(html, /Percebe quando o agente está em círculos/, "descrição vira dica (title), não texto sob a linha");
	assert.match(html, /Herdar \(geral: Observar\)/);
	assert.doesNotMatch(html.replace(/(class|style)="[^"]*"/g, ""), /Intenção|Delegação/);
	assert.doesNotMatch(html.replace(/(class|style)="[^"]*"/g, ""), /Revisão de escritas|Decisões auxiliares/);
});

test("Jev: sem chave do OpenRouter no servidor, aviso explica que o revisor usa o modelo escolhido ou a manutenção", () => {
	const html = render({ openrouterKey: false });
	assert.match(html, /Chave do OpenRouter não configurada no servidor: o revisor usa o modelo escolhido abaixo ou o de manutenção/);
	assert.doesNotMatch(render({ openrouterKey: true }), /Chave do OpenRouter não configurada/);
});

test("Jev: seletor do modelo do revisor no topo, com a legenda pedida e sem a palavra do app", () => {
	const html = render({});
	assert.match(html, /Modelo do revisor/);
	assert.match(html, /Modelo que revisa os runs, detecta travamentos e classifica pedidos. Use um modelo rápido./);
	assert.ok(html.indexOf("Modelo do revisor") < html.indexOf("Revisão de escritas em conectores"));
	assert.ok(html.includes("Herdar (Jev no OpenRouter)"));
	assert.doesNotMatch(html, /Atlas/);
});

test("Jev: carregando, erro de carga e erro ao salvar", () => {
	assert.match(render({ effective: null, config: null }), /Carregando…/);
	assert.match(render({ effective: null, config: null, loadError: "Não foi possível carregar as configurações." }), /role="alert"[^>]*>Não foi possível carregar/);
	assert.match(render({ status: "error", saveError: "Use off, shadow ou on." }), /role="alert"[^>]*>Use off/);
});

test("Jev: texto de ajuda avisa o custo sem inventar números", () => {
	const html = render();
	assert.match(html, /Observar registra sem agir/);
	assert.match(html, /soma tempo de espera/);
	assert.doesNotMatch(html.replace(/(class|style)="[^"]*"/g, ""), /\d+\s?(ms|s\b|%|tokens)/);
});

test("Grupos: coordenação inteligente é uma linha com switch (em Geral), desligada por padrão", () => {
	const account = (jevCoordination: unknown) =>
		({
			view: { effective: effective({ groups: jevCoordination }), capabilities: { openrouterKey: true } },
			save: async () => {},
		}) as unknown as Parameters<typeof GroupsCoordinationRow>[0]["account"];
	const html = renderToStaticMarkup(<GroupsCoordinationRow account={account({ value: false, source: "default" })} />);
	assert.match(html, /for="settings-jev-groups"[^>]*>Grupos: coordenação inteligente</);
	assert.match(html, /aria-checked="false"[^>]*aria-describedby="settings-jev-groups-hint"|aria-describedby="settings-jev-groups-hint"[^>]*aria-checked="false"/);
	assert.match(html, /Desligado, vale a escolha de sempre/, "descrição na dica");
	const on = renderToStaticMarkup(<GroupsCoordinationRow account={account({ value: true, source: "user" })} />);
	assert.match(on, /aria-checked="true"/);
	assert.match(on, /Voltar ao padrão/);
	assert.equal(renderToStaticMarkup(<GroupsCoordinationRow account={account({ value: false, source: "default" })} isVisible={() => false} />), "");
	// O JEV da tela Avançado não repete a linha de grupos.
	assert.doesNotMatch(render(), /settings-jev-groups/);
});
