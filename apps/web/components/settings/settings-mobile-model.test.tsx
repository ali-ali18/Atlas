import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/ui/templates/template-4/settings-list";
import { MOBILE_TITLES, connectionsHint, mobileSettingsGroups, reviewHint, skillsHint, usageHint } from "./settings-mobile-model";

Object.assign(globalThis, { React });

test("a lista mobile tem as seções do desktop (Conta fica no cartão de perfil), em blocos com título, Técnico no fim", () => {
	const groups = mobileSettingsGroups({ theme: "Escuro", defaultModel: "openai/gpt-4o-mini", chatgptEnabled: true });
	const ids = groups.flatMap((group) => group.rows.map((row) => row.id));
	assert.deepEqual(ids, ["geral", "notificacoes", "bots", "modelos", "provedores", "computador", "conexoes", "cofre", "habilidades", "uso", "execucao", "avancado"]);
	assert.deepEqual(groups.map((group) => group.label), ["Básico", "Bots e modelos", "Ferramentas", "Controle"]);
	assert.equal(groups[groups.length - 1]?.rows.at(-1)?.id, "avancado");
	const rows = groups.flatMap((group) => group.rows);
	assert.equal(rows.find((row) => row.id === "geral")?.secondary, "Tema escuro");
	assert.ok(rows.every((row) => row.title === MOBILE_TITLES[row.id]));
	assert.equal(MOBILE_TITLES.uso, "Uso e custos");
	assert.equal(rows.find((row) => row.id === "modelos")?.secondary, "openai/gpt-4o-mini");
	assert.equal(rows.find((row) => row.id === "provedores")?.secondary, "Plano ChatGPT ligado");
	assert.equal(MOBILE_TITLES.provedores, "Provedores e chaves");
	assert.equal(MOBILE_TITLES.avancado, "Técnico");
});

test("subtítulos mostram o estado atual", () => {
	const rows = mobileSettingsGroups({
		theme: "Sistema",
		defaultModel: "GPT-4o mini",
		browserAuto: true,
		connectionsCount: 4,
		skillsCount: 3,
		usageCostUsd: 3.2,
		reviewMode: "on",
	}).flatMap((g) => g.rows);
	const text = (id: string) => rows.find((r) => r.id === id)?.secondary;
	assert.equal(text("geral"), "Tema sistema");
	assert.equal(text("modelos"), "GPT-4o mini");
	assert.equal(text("computador"), "Navegador: automático");
	assert.equal(text("conexoes"), "4 conectados");
	assert.equal(text("habilidades"), "3 habilidades");
	assert.equal(text("uso"), "US$ 3,20 nos últimos 7 dias");
	assert.equal(text("avancado"), "Revisão JEV ligada");
	assert.ok(rows.every((r) => r.secondary.length <= 34));
});

test("enquanto carrega, usa o texto estático curto", () => {
	const rows = mobileSettingsGroups({}).flatMap((g) => g.rows);
	assert.ok(rows.every((r) => r.secondary.length > 0 && r.secondary.length <= 34));
	assert.equal(connectionsHint(undefined), "Conectores e MCP");
	assert.equal(skillsHint(undefined), "Procedimentos do agente");
	assert.equal(usageHint(undefined), "Consumo e gastos");
	assert.equal(reviewHint(undefined), "Revisão automática e diagnóstico");
});

test("contagem, custo e revisão nos casos de borda", () => {
	assert.equal(connectionsHint(0), "Nenhuma conexão");
	assert.equal(connectionsHint(1), "1 conectado");
	assert.equal(skillsHint(0), "Nenhuma habilidade");
	assert.equal(skillsHint(1), "1 habilidade");
	assert.equal(skillsHint(7), "7 habilidades");
	assert.equal(usageHint(null), "Consumo e gastos");
	assert.equal(usageHint(0), "US$ 0,00 nos últimos 7 dias");
	assert.equal(usageHint(0.0042), "US$ 0,0042 nos últimos 7 dias");
	assert.equal(reviewHint("off"), "Revisão desligada");
	assert.equal(reviewHint("shadow"), "Revisão JEV em teste");
	const manual = mobileSettingsGroups({ browserAuto: false }).flatMap((g) => g.rows);
	assert.equal(manual.find((r) => r.id === "computador")?.secondary, "Navegador: manual");
});

test("seções escondidas somem da lista", () => {
	const ids = mobileSettingsGroups({}, new Set(["avancado"])).flatMap((g) => g.rows.map((r) => r.id));
	assert.ok(!ids.includes("avancado"));
	assert.equal(ids.length, 11);
});

test("grupo e linha: blocos de 20px, 2px entre linhas, linha toca e mostra a seta", () => {
	const html = renderToStaticMarkup(
		<SettingsGroup>
			<SettingsRow onClick={() => {}} secondary="Sistema" title="Aparência" />
			<SettingsRow title="Estática" />
		</SettingsGroup>,
	);
	assert.match(html, /rounded-\[20px\]/);
	assert.match(html, /gap-0\.5/);
	assert.match(html, /<button[^>]*data-slot="settings-row"/);
	assert.match(html, />Sistema</);
	assert.match(html, /<div class="[^"]*" data-slot="settings-row">/);
});

test("página: título centralizado e botão de voltar acessível", () => {
	const html = renderToStaticMarkup(
		<SettingsPage backLabel="Voltar" onBack={() => {}} title="Conta">
			<p>x</p>
		</SettingsPage>,
	);
	assert.match(html, /aria-label="Voltar"/);
	assert.match(html, /text-center[^>]*>Conta</);
	assert.match(html, /safe-area-inset-top/);
});
