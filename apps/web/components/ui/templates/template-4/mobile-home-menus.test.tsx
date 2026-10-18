import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileBotRow, MobileSectionHeader } from "./mobile-chat-list";
import {
	LONG_PRESS_MS,
	accountMenuItems,
	botActionItems,
	createLongPress,
	sectionActionItems,
	sectionChoices,
} from "./mobile-home-menus";

Object.assign(globalThis, { React });

const agent = { id: "a1", name: "Zeca", color: "#fff", snippet: "", time: "10:00" };

test("menu do avatar: configurações gerais, marketplace, provedores, autonomia e sair", () => {
	const items = accountMenuItems();
	assert.deepEqual(
		items.map((item) => item.id),
		["settings", "marketplace", "providers", "autonomy", "logout"],
	);
	assert.equal(items[0]?.label, "Configurações gerais");
	assert.equal(items.find((item) => item.id === "logout")?.group, "session");
});

test("ações do bot alternam fixar/desafixar e lido/não lido", () => {
	const plain = botActionItems({}).map((item) => item.id);
	assert.ok(plain.includes("pin") && !plain.includes("unpin"));
	assert.ok(plain.includes("mark-unread") && !plain.includes("mark-read"));
	const pinned = botActionItems({ pinned: true, notifications: true }).map((item) => item.id);
	assert.ok(pinned.includes("unpin") && !pinned.includes("pin"));
	assert.ok(pinned.includes("mark-read") && !pinned.includes("mark-unread"));
	for (const id of ["open", "edit", "move", "hide", "delete", "copy-id"]) {
		assert.ok(plain.includes(id as never), id);
	}
	assert.equal(botActionItems({}).find((item) => item.id === "delete")?.destructive, true);
});

test("opções de sessão marcam a atual e oferecem remover", () => {
	const sections = [
		{ id: "s2", name: "B", order: 2 },
		{ id: "s1", name: "A", order: 1 },
	] as never;
	const choices = sectionChoices({ sectionId: "s1" }, sections);
	assert.deepEqual(choices.map((c) => c.label), ["A", "B", "Remover da sessão"]);
	assert.equal(choices[0]?.current, true);
	assert.equal(sectionChoices({ sectionId: null }, sections).length, 2);
});

function fakeTimers() {
	let pending: { fn: () => void; ms: number } | null = null;
	return {
		timers: {
			set: (fn: () => void, ms: number) => {
				pending = { fn, ms };
				return pending;
			},
			clear: (handle: unknown) => {
				if (pending === handle) pending = null;
			},
		},
		get pending() {
			return pending;
		},
	};
}

test("long-press dispara após o atraso e consome o click seguinte", () => {
	const fake = fakeTimers();
	let fired = 0;
	const press = createLongPress(() => fired++, { timers: fake.timers });
	press.start(10, 10);
	assert.equal(fake.pending?.ms, LONG_PRESS_MS);
	fake.pending?.fn();
	assert.equal(fired, 1);
	assert.equal(press.consumeFired(), true);
	assert.equal(press.consumeFired(), false);
});

test("long-press cancela ao mover além da tolerância e ao soltar", () => {
	const fake = fakeTimers();
	let fired = 0;
	const press = createLongPress(() => fired++, { timers: fake.timers });
	press.start(0, 0);
	press.move(3, 3);
	assert.ok(fake.pending);
	press.move(40, 0);
	assert.equal(fake.pending, null);
	assert.equal(fired, 0);
	assert.equal(press.consumeFired(), false);
	press.start(0, 0);
	press.cancel();
	assert.equal(fake.pending, null);
});

test("linha do bot: alvo >= 44px, sem seleção de texto, indicador de não lida", () => {
	const html = renderToStaticMarkup(
		<MobileBotRow agent={{ ...agent, notifications: true }} onMenu={() => {}} onOpen={() => {}} />,
	);
	assert.match(html, /min-h-\[4\.5rem\]/);
	assert.match(html, /select-none/);
	assert.match(html, /aria-label="Não lida"/);
	assert.match(html, /Zeca/);
	const read = renderToStaticMarkup(
		<MobileBotRow agent={agent} onMenu={() => {}} onOpen={() => {}} />,
	);
	assert.doesNotMatch(read, /Não lida/);
});

test("linha do bot: a bolinha de não lida fica no avatar, não no fim da prévia", () => {
	const html = renderToStaticMarkup(
		<MobileBotRow agent={{ ...agent, notifications: true, lastMessage: "oi" }} onMenu={() => {}} onOpen={() => {}} />,
	);
	assert.match(html, /data-avatar-dot="unread"/);
	assert.equal(html.match(/aria-label="Não lida"/g)?.length, 1);
	// Depois do texto da prévia não há mais bolinha.
	assert.doesNotMatch(html.slice(html.indexOf(">oi<")), /aria-label="Não lida"/);
	assert.match(html, /font-semibold/);
	assert.match(html, /motion-safe:animate-in/);
});

test("linha de grupo: bolinha no canto do avatar do grupo", () => {
	const html = renderToStaticMarkup(
		<MobileBotRow
			agent={{ ...agent, id: "g1", members: ["a1"], notifications: true }}
			agents={[agent]}
			onMenu={() => {}}
			onOpen={() => {}}
		/>,
	);
	assert.match(html, /aria-label="Grupo: não lida"/);
	assert.match(html, /data-avatar-status="unread"/);
});

test("todo item de menu tem ícone lucide", () => {
	const all = [
		...accountMenuItems(),
		...botActionItems({}),
		...botActionItems({ pinned: true, notifications: true }),
	];
	for (const item of all) {
		assert.ok(item.icon, item.id);
		const html = renderToStaticMarkup(<item.icon />);
		assert.match(html, /<svg[^>]*lucide/, item.id);
	}
});

test("folha de ações tem respiro inferior com safe-area", () => {
	const src = readFileSync(new URL("./mobile-chat-list.tsx", import.meta.url), "utf8");
	assert.match(src, /pb-\[max\(2rem,env\(safe-area-inset-bottom\)\)\]/);
	assert.match(src, /pb-\[max\(1\.5rem,env\(safe-area-inset-bottom\)\)\]/);
});

test("ações da sessão: renomear/excluir sempre; mover desabilita nas pontas", () => {
	const sections = [
		{ id: "a", order: 0 },
		{ id: "b", order: 1 },
	];
	const first = sectionActionItems("a", sections);
	assert.deepEqual(
		first.map((item) => item.label),
		["Renomear", "Mover para cima", "Mover para baixo", "Excluir"],
	);
	assert.equal(first[1]?.disabled, true);
	assert.equal(first[2]?.disabled, false);
	const last = sectionActionItems("b", sections);
	assert.equal(last[1]?.disabled, false);
	assert.equal(last[2]?.disabled, true);
	assert.equal(last[3]?.destructive, true);
});

test("título de sessão mobile não é selecionável e expõe o botão de ações", () => {
	const html = renderToStaticMarkup(
		<MobileSectionHeader name="Códigos" onCancelRename={() => {}} onCommitRename={() => {}} onMenu={() => {}} renaming={false} />,
	);
	assert.match(html, /select-none/);
	assert.match(html, /-webkit-touch-callout:none/);
	assert.match(html, /Ações da sessão Códigos/);
});

test("renomear troca o título por um campo com o nome atual", () => {
	const html = renderToStaticMarkup(
		<MobileSectionHeader name="Nova sessão" onCancelRename={() => {}} onCommitRename={() => {}} onMenu={() => {}} renaming />,
	);
	assert.match(html, /<input/);
	assert.match(html, /value="Nova sessão"/);
});
