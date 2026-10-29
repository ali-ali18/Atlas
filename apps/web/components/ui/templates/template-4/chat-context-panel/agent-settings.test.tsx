import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withDecideForOtherBots } from "@workspace/shared";
import { type Agent } from "../data";
import { AGENT_SETTINGS_TITLES, AgentSettings } from "./agent-settings";
import { ChatContextPanel } from "./chat-context-panel";

Object.assign(globalThis, { React });

const bot = (patch: Partial<Agent> & { policyJson?: unknown } = {}): Agent =>
	({ id: "b1", name: "Zeca", snippet: "Dev", color: "#6366f1", time: "", ...patch }) as Agent;
const render = (agent: Agent, props: Partial<React.ComponentProps<typeof AgentSettings>> = {}) =>
	renderToStaticMarkup(<AgentSettings agent={agent} onChange={() => {}} {...props} />);

test("vista principal: Nome, Rótulo e o cartão Modelo, Autonomia, Idioma e Notificações", () => {
	const html = render(bot());
	assert.match(html, /for="agent-name"[^>]*>Nome</);
	assert.match(html, /value="Zeca"/);
	assert.match(html, /for="agent-title"[^>]*>Rótulo</);
	assert.match(html, /value="Dev"/);
	for (const label of ["Modelo", "Idioma", "Notificações"]) assert.match(html, new RegExp(`>${label}<`));
	assert.match(html, />Autonomia</);
	assert.match(html, /rounded-card border border-border\/60 py-2/, "cartão de cantos 12");
	assert.doesNotMatch(html, /divide-y/);
});

test("Modelo vem como 'Herdar da conta' quando o bot não escolheu um", () => {
	assert.match(render(bot()), /Herdar da conta/);
	assert.doesNotMatch(render(bot({ openRouterModel: "openai/gpt-4o-mini" })), />Herdar da conta</);
});

test("Notificações: o switch carrega a descrição ao lado, visível", () => {
	const html = render(bot());
	assert.match(html, /Receba uma notificação quando este bot terminar ou precisar de você\./);
	assert.match(html, /id="agent-notifications"/);
	assert.match(html, /aria-checked="true"/, "ligado por padrão");
	assert.match(render(bot({ notifications: false })), /aria-checked="false"/);
});

test("Sobre: a descrição do bot se edita nas configurações, com placeholder quando vazia", () => {
	const empty = render(bot());
	assert.match(empty, /data-about/);
	assert.match(empty, />Sobre</);
	assert.match(empty, /aria-label="Editar descrição do bot"/);
	assert.match(empty, />Adicionar uma descrição</);
	assert.ok(empty.indexOf('for="agent-title"') < empty.indexOf("data-about"), "Sobre vem depois do Rótulo");
	const filled = render(bot({ description: "Cuida do financeiro" }));
	assert.match(filled, />Cuida do financeiro</);
	assert.doesNotMatch(filled, /Adicionar uma descrição/);
});

test("Sobre: descrição longa fica recolhida com 'Mostrar mais'", () => {
	const html = render(bot({ description: "texto longo ".repeat(40) }));
	assert.match(html, /line-clamp-6/);
	assert.match(html, />Mostrar mais</);
	assert.doesNotMatch(render(bot({ description: "curta" })), /Mostrar mais/);
});

test("saíram das configurações: campo Descrição solto, Título, 'Bot principal' e o botão Salvar", () => {
	const html = render(bot({ isPrimary: true }));
	assert.doesNotMatch(html, /agent-description/);
	assert.doesNotMatch(html, /Título/);
	assert.doesNotMatch(html, /Bot principal/);
	assert.doesNotMatch(html, />Salvar</);
});

test("linha 'Modo proativo' só existe no bot principal", () => {
	const primary = render(bot({ isPrimary: true }));
	assert.match(primary, />Modo proativo</);
	assert.match(primary, /aria-label="Abrir Modo proativo"/);
	assert.match(primary, />Desligado</);
	const other = render(bot({ isPrimary: false }));
	assert.doesNotMatch(other, /Modo proativo/);
	assert.doesNotMatch(render(bot()), /Modo proativo/);
});

test("linha 'Modo proativo' mostra Ligado quando o modo está ativo", () => {
	assert.match(render(bot({ isPrimary: true, policyJson: { proactive: { enabled: true } } })), />Ligado</);
});

test("subvista do Modo proativo (principal): interruptor e opções; título próprio", () => {
	const html = render(bot({ isPrimary: true, policyJson: { proactive: { enabled: true } } }), { page: "proactive" });
	assert.match(html, /data-agent-settings-page="proactive"/);
	assert.match(html, /aria-label="Modo proativo"/);
	assert.match(html, /data-proactive-options/);
	assert.doesNotMatch(html, /for="agent-name"/);
	assert.equal(AGENT_SETTINGS_TITLES.proactive, "Modo proativo");
	assert.equal(AGENT_SETTINGS_TITLES.main, "Configurações");
});

test("subvista do Modo proativo num bot que não é principal cai na vista principal", () => {
	const html = render(bot({ isPrimary: false }), { page: "proactive" });
	assert.match(html, /data-agent-settings-page="main"/);
	assert.doesNotMatch(html, /Modo proativo/);
});

test("painel em view=settings mostra as configurações novas, com voltar e fechar", () => {
	const html = renderToStaticMarkup(
		<ChatContextPanel agent={bot({ isPrimary: true })} onOpenSettings={() => {}} onUpdate={() => {}} view="settings" />,
	);
	assert.match(html, /aria-label="Voltar"/);
	assert.match(html, /aria-label="Fechar painel"/);
	assert.match(html, /data-agent-settings-page="main"/);
	assert.match(html, />Modo proativo</);
	const secondary = renderToStaticMarkup(
		<ChatContextPanel agent={bot({ isPrimary: false })} onOpenSettings={() => {}} onUpdate={() => {}} view="settings" />,
	);
	assert.doesNotMatch(secondary, /Modo proativo/);
});

test("Modelo para código: herda da conta, ou do modelo do bot quando a conta não define", () => {
	assert.ok(render(bot()).includes(">Modelo (código)<"));
	assert.match(render(bot()), /id="agent-coding-model"/);
	assert.ok(render(bot()).includes("Igual ao bot"));
	assert.match(render(bot(), { accountCodingModel: "anthropic/claude-sonnet-5.5" }), /Herdar \(anthropic\/claude-sonnet-5\.5\)/);
});

/** Estado (aria-checked) do interruptor que vem logo depois do rótulo da linha. */
const decideSwitchState = (html: string): string | undefined =>
	/aria-checked="(true|false)"/.exec(html.slice(html.indexOf('for="agent-decide-for-others"')))?.[1];

test("'Decidir pelos outros bots': desligado por padrão, com a dica, logo depois da Autonomia", () => {
	const html = render(bot());
	assert.match(html, /for="agent-decide-for-others"[^>]*>Decidir pelos outros bots</);
	assert.match(html, /Aprovações e perguntas dos bots que este bot aciona são decididas por ele junto com o Jev; se não tiver certeza, chegam para você\./);
	assert.equal(decideSwitchState(html), "false");
	assert.ok(html.indexOf(">Autonomia<") < html.indexOf("Decidir pelos outros bots"), "fica na área de Autonomia");
	assert.ok(html.indexOf("Decidir pelos outros bots") < html.indexOf('for="agent-language"'));
});

test("'Decidir pelos outros bots' lê a política do bot e liga ao salvar sem perder outras chaves", () => {
	assert.equal(decideSwitchState(render(bot({ policyJson: { decideForOtherBots: true } }))), "true");
	assert.equal(decideSwitchState(render(bot({ policyJson: { decideForOtherBots: "sim" } }))), "false");
	assert.deepEqual(withDecideForOtherBots({ subagentModel: "a/b" }, true), { subagentModel: "a/b", decideForOtherBots: true });
});

test("Modelos por dificuldade: linha no bot mostra 'Da conta' ou 'Personalizado' e abre a subvista", () => {
	assert.match(render(bot()), /aria-label="Abrir Modelos por dificuldade"/);
	assert.ok(render(bot()).includes(">Da conta<"));
	assert.ok(render(bot({ policyJson: { modelTiers: { hard: ["a/forte"] } } })).includes(">Personalizado<"));
	assert.equal(AGENT_SETTINGS_TITLES.tiers, "Modelos por dificuldade");
});

test("subvista de níveis do bot: Fácil, Média e Difícil, com os modelos do bot e 'Usa o da conta' nos vazios", () => {
	const html = render(bot({ policyJson: { modelTiers: { hard: ["a/forte"] } } }), { page: "tiers" });
	assert.match(html, /data-agent-settings-page="tiers"/);
	for (const label of ["Fácil", "Média", "Difícil"]) assert.ok(html.includes(`>${label}<`), label);
	assert.ok(html.includes("a/forte"));
	assert.equal((html.match(/Usa o da conta\./g) ?? []).length, 2);
	assert.doesNotMatch(html, /for="agent-name"/);
});

test("Planejar antes de tarefas grandes: ligado por padrão, so planMode:false desliga, e o texto diz que escritas seguem pedindo confirmação", () => {
	const state = (html: string) => /aria-checked="(true|false)"/.exec(html.slice(html.indexOf('for="agent-plan-mode"')))?.[1];
	assert.match(render(bot()), /Planejar antes de tarefas grandes/);
	assert.match(render(bot()), /não aprova as ações/);
	assert.equal(state(render(bot())), "true");
	assert.equal(state(render(bot({ policyJson: { planMode: false } }))), "false");
});
