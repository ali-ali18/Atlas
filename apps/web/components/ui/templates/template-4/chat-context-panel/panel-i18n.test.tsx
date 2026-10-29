import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator, type Translator } from "@/lib/i18n/translator";
import type { Agent } from "../data";
import { AboutSection } from "./about-section";
import { agentSettingsTitle, AgentSettings, codingInheritLabel } from "./agent-settings";
import { addAllowedSender, emailPeer, emailStatusBadge, emailSubject, moreSendersLabel, sendersCountLabel } from "./bot-email-helpers";
import { BotLibraryList } from "./bot-library";
import { ChatContextPanel, SleepingComputer } from "./chat-context-panel";
import { GroupPanelContent } from "./group-panel";
import { memoryChangeScope, memoryChangeVerb, memoryOriginLabel } from "./memory-tab-helpers";
import { PagesList, routineSummaryByPage } from "./pages-library";
import { ProactiveSettingsSection } from "./proactive-settings";
import { stopComputerLabel } from "./stop-computer-button";

Object.assign(globalThis, { React });

const agent: Agent = { color: "#6366f1", id: "bot-1", name: "Zeca", snippet: "Dev", time: "" };
const en = async (): Promise<Translator> => createTranslator("en-US", await loadMessages("en-US"));

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

test("painel lateral: abas, topo e rótulos no idioma da tela", async () => {
	const out = await wrap("en-US", <ChatContextPanel agent={agent} onOpenSettings={() => {}} onUpdate={() => {}} />);
	for (const text of ["Library", "Computer", "Email"]) assert.match(out, new RegExp(`>${text}<`));
	assert.match(out, /aria-label="Bot settings"/);
	assert.match(out, /aria-label="Close panel"/);
	assert.match(out, /aria-label="Resize panel"/);
	assert.match(out, /aria-label="Panel sections"/);
	assert.match(out, />Panels</);
	assert.match(out, />Routines</);
	assert.doesNotMatch(out, /Biblioteca|Computador|Fechar painel|Painéis/);
	const es = await wrap("es-ES", <ChatContextPanel agent={agent} onUpdate={() => {}} />);
	assert.match(es, /aria-label="Cerrar panel"/);
	assert.match(es, />Rutinas</);
});

test("computador dormindo e botão de desligar", async () => {
	const translator = await en();
	assert.match(await wrap("en-US", <SleepingComputer agent={agent} />), /The computer is asleep/);
	assert.match(await wrap("es-ES", <SleepingComputer agent={agent} busy restarting />), /Reiniciando la VM…/);
	assert.equal(stopComputerLabel(true, translator), "Turning off…");
	assert.equal(stopComputerLabel(false), "Desligar computador");
});

test("configurações do bot em en: campos, títulos e modo proativo", async () => {
	const out = await wrap("en-US", <AgentSettings agent={{ ...agent, isPrimary: true } as Agent} onChange={() => {}} />);
	assert.match(out, /for="agent-name"[^>]*>Name</);
	assert.match(out, /Get a notification when this bot finishes or needs you\./);
	assert.match(out, />Proactive mode</);
	assert.match(out, />Decide for other bots</);
	assert.match(out, />Plan before big tasks</);
	assert.doesNotMatch(out, /Nome|Notificações|Modo proativo|Receba uma/);
	const translator = await en();
	assert.equal(agentSettingsTitle("tiers", translator), "Models by difficulty");
	assert.equal(agentSettingsTitle("main"), "Configurações");
	assert.equal(codingInheritLabel(undefined, [], translator), "Same as the bot");
	assert.equal(codingInheritLabel("x/y", [], translator), "Inherit (x/y)");
	const pro = await wrap("en-US", <ProactiveSettingsSection agent={{ ...agent, isPrimary: true, policyJson: { proactive: { enabled: true, timezone: "America/Sao_Paulo" } } } as Agent} onChange={() => {}} />);
	assert.match(pro, />Suggest</);
	assert.match(pro, /The bot shows a card and you choose whether to create the routine\./);
	assert.match(pro, /Max proactive messages per day/);
	assert.match(pro, /aria-label="Quiet hours start"/);
	assert.match(await wrap("es-ES", <AboutSection description="" onChange={() => {}} />), /Añadir una descripción/);
});

test("biblioteca em en: painéis, documentos e estados vazios", async () => {
	const list = await wrap("en-US", <PagesList items={[]} />);
	assert.match(list, /Ask the bot for a panel or report/);
	const docs = await wrap("es-ES", <BotLibraryList files={[]} />);
	assert.match(docs, /Los documentos que crea este Bot/);
	const translator = await en();
	assert.equal(routineSummaryByPage([{ id: "r", name: "n", instruction: "", model: "", active: false, pageId: "p", triggerKind: "interval", triggers: [{ id: "interval", text: "", everyMinutes: 50 }] }], translator).get("p"), "Every 50 min (paused)");
	const page = { id: "p1", title: "Vendas", sourceCount: 3, updatedAt: "2026-10-14T00:00:00.000Z", refreshedAt: null } as never;
	const html = await wrap("en-US", <PagesList items={[page]} now={new Date("2026-10-14T02:00:00.000Z")} />);
	assert.match(html, /3 sources/);
	assert.match(html, /Updated 2 hr\. ago|Updated 2 hours ago|Updated 2 hr ago/);
	assert.match(html, /aria-label="Open panel Vendas"/);
});

test("painel de grupo em es", async () => {
	const members = [agent, { ...agent, id: "b2", name: "Ana" }];
	const out = await wrap("es-ES", <GroupPanelContent agent={{ ...agent, name: "Time" }} group={{ members, candidates: [], onRename: () => {}, onAddMember: () => {}, onRemoveMember: () => {}, onDelete: () => {} }} />);
	assert.match(out, /2 miembros/);
	assert.match(out, />Miembros</);
	assert.match(out, /Un grupo necesita al menos 2 bots/);
	assert.match(out, /Eliminar grupo/);
});

test("e-mail do bot: ajudantes no idioma da tela e pt-BR igual ao de sempre", async () => {
	const translator = await en();
	assert.equal(emailPeer({ direction: "in", from: "a@b.c", to: [] }), "De a@b.c");
	assert.equal(emailPeer({ direction: "out", from: "", to: ["x@y.z"] }, translator), "To x@y.z");
	assert.equal(emailSubject({ subject: "  " }), "(sem assunto)");
	assert.equal(emailSubject({ subject: "" }, translator), "(no subject)");
	assert.deepEqual(emailStatusBadge({ status: "blocked" }, translator), { label: "Blocked", tone: "danger" });
	assert.equal(moreSendersLabel(1), "+1 remetente");
	assert.equal(moreSendersLabel(3, translator), "+3 senders");
	assert.equal(sendersCountLabel(1, translator), "1 sender");
	const bad = addAllowedSender([], "não é email", translator);
	assert.deepEqual(bad, { ok: false, error: "Enter an email (ana@company.com) or a domain (@company.com)." });
	assert.deepEqual(addAllowedSender(["a@b.com"], "a@b.com", translator), { ok: false, error: "That sender is already on the list." });
});

test("memória: rótulos de origem e mudança por idioma", async () => {
	const translator = await en();
	assert.equal(memoryOriginLabel("user", translator), "You added it");
	assert.equal(memoryOriginLabel("user"), "Você adicionou");
	assert.equal(memoryChangeVerb({ action: "add", undoOfId: "x" }, translator), "Undone · Deleted");
	assert.equal(memoryChangeScope({ target: "user" }, translator), "About you");
});
