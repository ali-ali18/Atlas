import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { botActionItems } from "./mobile-home-menus";
import { primaryBadgeMetrics, PrimaryBotBadge } from "./primary-bot-badge";
import { PrimaryBotRadioList } from "./primary-bot-dialogs";
import {
	pickablePrimaryBots,
	primaryIntroKey,
	readPrimaryIntroDismissed,
	shouldShowPrimaryIntro,
	writePrimaryIntroDismissed,
} from "./primary-bot-logic";

Object.assign(globalThis, { React });

const bot = (id: string, extra: object = {}) => ({ id, name: `Bot ${id}`, color: "#fff", snippet: "x", time: "", ...extra });

test("intro aparece só com 2+ bots, sem principal, não dispensado e carregado", () => {
	const two = [bot("a"), bot("b")];
	assert.equal(shouldShowPrimaryIntro({ agents: two, loading: false, dismissed: false }), true);
	assert.equal(shouldShowPrimaryIntro({ agents: [bot("a")], loading: false, dismissed: false }), false);
	assert.equal(shouldShowPrimaryIntro({ agents: [bot("a", { isPrimary: true }), bot("b")], loading: false, dismissed: false }), false);
	assert.equal(shouldShowPrimaryIntro({ agents: two, loading: true, dismissed: false }), false);
	assert.equal(shouldShowPrimaryIntro({ agents: two, loading: false, dismissed: true }), false);
	assert.equal(shouldShowPrimaryIntro({ agents: two, loading: false, dismissed: false, busy: true }), false);
	// grupos não contam como bots
	assert.equal(shouldShowPrimaryIntro({ agents: [bot("a"), bot("g", { members: ["a", "b"] })], loading: false, dismissed: false }), false);
});

test("dispensa persiste por usuário e tolera storage quebrado", () => {
	const data = new Map<string, string>();
	const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
	const key = primaryIntroKey("u1");
	assert.equal(readPrimaryIntroDismissed(storage, key), false);
	writePrimaryIntroDismissed(storage, key);
	assert.equal(readPrimaryIntroDismissed(storage, key), true);
	assert.equal(readPrimaryIntroDismissed(storage, primaryIntroKey("u2")), false);
	const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
	assert.equal(readPrimaryIntroDismissed(broken, key), false);
	assert.doesNotThrow(() => writePrimaryIntroDismissed(broken, key));
	assert.equal(readPrimaryIntroDismissed(null, key), false);
});

test("seletor exclui o principal atual e filtra pela busca", () => {
	const agents = [bot("a", { isPrimary: true }), bot("b", { name: "Zeca" }), bot("c", { name: "Bia" })];
	assert.deepEqual(pickablePrimaryBots(agents).map((b) => b.id), ["b", "c"]);
	assert.deepEqual(pickablePrimaryBots(agents, " zec ").map((b) => b.id), ["b"]);
});

test("lista de escolha: radiogroup, item marcado e estado vazio", () => {
	const html = renderToStaticMarkup(<PrimaryBotRadioList bots={[bot("b"), bot("c")]} label="Bots" onSelect={() => undefined} selectedId="c" />);
	assert.match(html, /role="radiogroup"/);
	assert.equal((html.match(/role="radio"/g) ?? []).length, 2);
	assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
	assert.match(renderToStaticMarkup(<PrimaryBotRadioList bots={[]} label="Bots" onSelect={() => undefined} selectedId={null} />), /Ainda não há outros bots para escolher/);
});

test("menu do bot: definir como principal / trocar, só com 2+ bots e fora de grupos", () => {
	const ids = (a: object, canPickPrimary = true) => botActionItems(a, { canPickPrimary }).map((i) => i.id);
	assert.ok(ids({}).includes("set-primary"));
	assert.ok(ids({ isPrimary: true }).includes("replace-primary"));
	assert.ok(!ids({ isPrimary: true }).includes("set-primary"));
	assert.ok(!ids({}, false).includes("set-primary"));
	assert.ok(!ids({ members: ["a", "b"] }).includes("set-primary"));
});

test("estrela: medidas fixas por tamanho de avatar e sem lucide", () => {
	assert.deepEqual(primaryBadgeMetrics(36), { badge: 12, glyph: 6, gap: 2 });
	assert.deepEqual(primaryBadgeMetrics(60), { badge: 16, glyph: 8, gap: 2.7 });
	const html = renderToStaticMarkup(<PrimaryBotBadge show size={60}><span>av</span></PrimaryBotBadge>);
	assert.match(html, /viewBox="0 0 24 24"/);
	assert.match(html, /mask-image/);
});
