import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Agent, Message } from "./data";
import { GroupAvatar, resolveGroupMembers } from "./group-avatar";
import { GroupPanelContent } from "./chat-context-panel/group-panel";
import { GroupAssistantRow } from "./chat-thread/group-message";
import { MentionPopup } from "./chat-thread/mention-popup";
import { renderMentions } from "./chat-thread/mention-text";
import { MessageRow } from "./chat-thread/message-row";
import { ChatComposer } from "./chat-thread/chat-composer";
import { botActionItems } from "./mobile-home-menus";
import { MobileBotRow } from "./mobile-chat-list";
import { NewChatTo, canCreateGroup, defaultGroupName, groupCandidates, recipientRows } from "./new-group";

Object.assign(globalThis, { React });

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
	id,
	name,
	color: "#2196f3",
	snippet: "",
	time: "",
	...extra,
});
const ana = agent("ana", "Ana", { isPrimary: true, description: "Coordena o time" });
const bia = agent("bia", "Bia", { color: "#e91e63", description: "Financeiro" });
const caio = agent("caio", "Caio", { color: "#4caf50" });
const time = agent("time", "Time", { members: ["ana", "bia", "caio"] });
const all = [ana, bia, caio, time];

const count = (html: string, needle: string) => html.split(needle).length - 1;
const isDisabled = (tag: string) => /\sdisabled(=|>|\s)/.test(tag);
const tagWith = (html: string, label: string) => html.match(new RegExp("<button[^>]*aria-label=\"" + label + "\"[^>]*>"))?.[0] ?? "";

test("avatar do grupo empilha até 3 membros; resolve só quem existe", () => {
	assert.equal(count(renderToStaticMarkup(<GroupAvatar members={[ana, bia]} />), "ring-2"), 2);
	assert.equal(count(renderToStaticMarkup(<GroupAvatar members={[ana, bia, caio, agent("d", "Dani")]} />), "ring-2"), 3);
	assert.deepEqual(
		resolveGroupMembers({ members: ["ana", "fantasma", "caio"] }, all).map((m) => m.id),
		["ana", "caio"],
	);
});

test("candidatos a membro excluem grupos; criar exige 2 a 8 membros; nome padrão junta os nomes", () => {
	assert.deepEqual(groupCandidates(all).map((a) => a.id), ["ana", "bia", "caio"]);
	assert.equal(canCreateGroup(["ana"]), false);
	assert.equal(canCreateGroup(["ana", "bia"]), true);
	assert.equal(canCreateGroup(Array.from({ length: 9 }, (_, i) => `m${i}`)), false);
	assert.equal(defaultGroupName(["Ana"]), "Ana");
	assert.equal(defaultGroupName(["Ana", "Bia"]), "Ana e Bia");
	assert.equal(defaultGroupName(["Ana", "Bia", "Caio"]), "Ana, Bia e Caio");
	assert.ok(defaultGroupName(Array.from({ length: 8 }, () => "N".repeat(20))).length <= 80);
});

test("campo Para:: sem chips oferece criar bot/grupo e todos os bots; em grupo só candidatos fora dos chips", () => {
	const idle = recipientRows(all, [], "", false);
	assert.deepEqual(idle.map((r) => (r.kind === "agent" ? r.agent.id : r.kind)), ["new-bot", "new-group", "ana", "bia", "caio", "time"]);
	const compose = recipientRows(all, ["ana"], "", false);
	assert.deepEqual(compose.map((r) => (r.kind === "agent" ? r.agent.id : r.kind)), ["bia", "caio"]);
	assert.deepEqual(recipientRows(all, [], "criar chat", true).map((r) => r.kind), []);
	assert.deepEqual(recipientRows(all, [], "bi", false).map((r) => (r.kind === "agent" ? r.agent.id : r.kind)), ["bia"]);
});

test("tela Para:: modo grupo mostra \"Adicionar ao chat em grupo\" e o composer fica travado até 2 bots", () => {
	const html = renderToStaticMarkup(
		<NewChatTo agents={all} initialGroupMode onCancel={() => {}} onNewBot={() => {}} onOpenBot={() => {}} onSend={async () => true} />,
	);
	assert.match(html, /Para:/);
	assert.match(html, /Adicionar ao chat em grupo/);
	assert.ok(!html.includes("Criar chat em grupo"));
	assert.match(html, /Mensagem para o grupo/);
	assert.match(tagWith(html, "Enviar"), /disabled/);
	const idle = renderToStaticMarkup(
		<NewChatTo agents={all} onCancel={() => {}} onNewBot={() => {}} onOpenBot={() => {}} onSend={async () => true} />,
	);
	assert.match(idle, /Criar novo Bot/);
	assert.match(idle, /Criar chat em grupo/);
});

test("composer de grupo: sem modelo nem anexo, com dica de @; o normal segue igual", () => {
	const group = renderToStaticMarkup(<ChatComposer agentName="Time" mentionMembers={[{ id: "ana", name: "Ana" }]} onSend={() => {}} />);
	assert.match(group, /Mensagem para Time/);
	assert.ok(!group.includes('aria-label="Modelo de linguagem"'));
	assert.ok(!group.includes('aria-label="Adicionar"'));
	const normal = renderToStaticMarkup(<ChatComposer agentName="Ana" model="gpt-4o" onSend={() => {}} />);
	assert.ok(normal.includes('aria-label="Modelo de linguagem"'));
	assert.ok(normal.includes('aria-label="Adicionar"'));
});

test("painel do grupo: membros com Remover; no mínimo (2) o Remover trava; cabeçalho com nome editável", () => {
	const props = { onAddMember: () => {}, onDelete: () => {}, onRemoveMember: () => {}, onRename: () => {} };
	const three = renderToStaticMarkup(<GroupPanelContent agent={time} group={{ ...props, candidates: [agent("dani", "Dani")], members: [ana, bia, caio] }} />);
	assert.equal(count(three, 'data-member="'), 3);
	assert.match(three, /3 membros/);
	assert.match(three, /aria-label="Nome do grupo"/);
	assert.match(three, /Abrir o chat de Ana/);
	assert.match(three, /Remover Bia/);
	assert.ok(tagWith(three, "Remover Bia") && !isDisabled(tagWith(three, "Remover Bia")));
	assert.ok(tagWith(three, "Adicionar membros") && !isDisabled(tagWith(three, "Adicionar membros")));
	const two = renderToStaticMarkup(<GroupPanelContent agent={time} group={{ ...props, candidates: [], error: "Falhou", members: [ana, bia] }} />);
	assert.ok(isDisabled(tagWith(two, "Remover Ana")));
	assert.match(two, /Crie mais Bots|Adicionar membros/);
	assert.match(two, /role="alert"[^>]*>Falhou/);
});

test("menu de pressionar-e-segurar de grupo: informações e excluir grupo, sem bot principal", () => {
	const items = botActionItems({ members: ["ana", "bia"] }, { canPickPrimary: true });
	assert.equal(items.find((item) => item.id === "edit")?.label, "Informações do grupo");
	assert.equal(items.find((item) => item.id === "delete")?.label, "Excluir grupo");
	assert.ok(!items.some((item) => item.id === "set-primary" || item.id === "replace-primary"));
});

test("linha mobile do grupo: avatares dos membros e contagem", () => {
	const html = renderToStaticMarkup(<MobileBotRow agent={time} agents={all} onMenu={() => {}} onOpen={() => {}} />);
	assert.match(html, /data-slot="group-avatar"/);
	assert.match(html, /data-testid="group-count"[^>]*>(?:(?!<\/span>).)*3/s);
	const plain = renderToStaticMarkup(<MobileBotRow agent={ana} agents={all} onMenu={() => {}} onOpen={() => {}} />);
	assert.ok(!plain.includes("group-avatar") && !plain.includes("group-count"));
});
