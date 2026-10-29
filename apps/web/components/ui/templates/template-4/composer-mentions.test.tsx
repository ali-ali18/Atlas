import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Message } from "./data";
import { MentionPopup } from "./chat-thread/mention-popup";
import { renderMentions } from "./chat-thread/mention-text";
import { MessageRow } from "./chat-thread/message-row";

Object.assign(globalThis, { React });

const skills = [
	{ id: "pesquisar", name: "pesquisar", description: "Pesquisa na web" },
	{ id: "criar-planilha", name: "criar-planilha", description: "Monta planilhas" },
];

test("popup de skills: linhas com /nome e descrição, destaque no ativo, rolável", () => {
	const html = renderToStaticMarkup(<MentionPopup activeIndex={1} candidates={skills} onPick={() => {}} trigger="/" />);
	assert.match(html, /aria-label="Escolher habilidade"/);
	assert.match(html, /data-trigger="\//);
	assert.match(html, /\/pesquisar/);
	assert.match(html, /Monta planilhas/);
	assert.match(html, /overflow-y-auto/);
	assert.match(html, /inset-x-0/);
	assert.ok(!html.includes("w-80"));
	assert.equal(html.match(/role="option"/g)?.length, 2);
	assert.match(html, /aria-selected="true"[^>]*>(?:(?!<\/button>).)*criar-planilha/s);
});

test("popup de skills e de bots mostram o estado vazio", () => {
	assert.match(renderToStaticMarkup(<MentionPopup activeIndex={0} candidates={[]} onPick={() => {}} trigger="/" />), /Nenhuma habilidade/);
	const bots = renderToStaticMarkup(<MentionPopup ariaLabel="Mencionar outro bot" activeIndex={0} candidates={[]} onPick={() => {}} trigger="@" />);
	assert.match(bots, /Nenhum outro bot/);
	assert.match(bots, /aria-label="Mencionar outro bot"/);
	assert.ok(!bots.includes('role="option"'));
});

test("popup de bots: avatar e nome", () => {
	const html = renderToStaticMarkup(
		<MentionPopup activeIndex={0} candidates={[{ id: "b1", name: "Bia", description: "Financeiro" }]} onPick={() => {}} trigger="@" />,
	);
	assert.match(html, /Bia/);
	assert.match(html, /Financeiro/);
	assert.ok(!html.includes("/Bia"));
});

test("balão do usuário: /skill conhecida e @Bot viram chips neutros; o resto fica texto", () => {
	const members = [{ id: "b1", name: "Bia" }];
	const html = renderToStaticMarkup(<>{renderMentions("use /pesquisar e pergunte à @Bia sobre /tmp e /desconhecida", members, new Set(["pesquisar"]))}</>);
	assert.equal(html.match(/data-slot="skill-chip"/g)?.length, 1);
	assert.equal(html.match(/data-slot="mention-chip"/g)?.length, 1);
	assert.match(html, /\/pesquisar<\/span>/);
	assert.match(html, /\/tmp e \/desconhecida/);
});

test("MessageRow 1:1: chips de skill no balão do usuário, texto puro sem skills conhecidas", () => {
	const message: Message = { id: "m1", kind: "user", text: "faz /pesquisar agora" };
	const withSkills = renderToStaticMarkup(<MessageRow knownSkills={new Set(["pesquisar"])} message={message} />);
	assert.match(withSkills, /data-slot="skill-chip"/);
	const plain = renderToStaticMarkup(<MessageRow message={message} />);
	assert.ok(!plain.includes("skill-chip"));
	assert.match(plain, /faz \/pesquisar agora/);
});

test("popup do @ com apps: seções Bots e Apps, logo (ou inicial) e status Conectado/Entrar", () => {
	const candidates = [
		{ id: "b1", name: "Bia", kind: "bot" as const },
		{ id: "catalog:gmail", name: "Gmail", kind: "app" as const, logo: "/connectors/gmail.svg", connected: true },
		{ id: "catalog:notion", name: "Notion", kind: "app" as const, logo: null, connected: false },
	];
	const html = renderToStaticMarkup(<MentionPopup activeIndex={0} candidates={candidates} onPick={() => {}} trigger="@" />);
	assert.deepEqual(html.match(/data-slot="mention-section"[^>]*>([^<]+)</g)?.map((part) => part.replace(/.*>/, "").replace("<", "")), ["Bots", "Apps"]);
	assert.match(html, /src="\/connectors\/gmail.svg"/);
	assert.match(html, /data-slot="app-logo-initial"[^>]*>N</);
	assert.match(html, /data-slot="mention-app-status"[^>]*>Conectado</);
	assert.match(html, /data-slot="mention-app-status"[^>]*>Entrar</);
	assert.equal(html.match(/role="option"/g)?.length, 3);
	// Sem apps (grupo ou sem conectores) não há seções.
	const plain = renderToStaticMarkup(<MentionPopup activeIndex={0} candidates={[candidates[0]!]} onPick={() => {}} trigger="@" />);
	assert.ok(!plain.includes("mention-section"));
});

test("balão do usuário: @App vira chip neutro com a logo pequena", () => {
	const members = [
		{ id: "b1", name: "Bia" },
		{ id: "catalog:gmail", name: "Gmail", kind: "app" as const, logo: "/connectors/gmail.svg" },
		{ id: "catalog:notion", name: "Notion", kind: "app" as const, logo: null },
	];
	const html = renderToStaticMarkup(<>{renderMentions("lê o @Gmail, anota no @Notion e avisa @Bia", members)}</>);
	assert.equal(html.match(/data-slot="app-chip"/g)?.length, 2);
	assert.equal(html.match(/data-slot="mention-chip"/g)?.length, 1);
	assert.match(html, /src="\/connectors\/gmail.svg"/);
	assert.match(html, /data-slot="app-logo-initial"/);
});
