import assert from "node:assert/strict";
import test from "node:test";
import { applyMention, mentionState, stepMentionIndex, triggerState } from "./mention-input";

const members = [
	{ id: "ana", name: "Ana" },
	{ id: "bia", name: "Bia" },
	{ id: "caio", name: "Caio Souza" },
];

test("abre ao digitar @ e filtra por prefixo; fecha sem candidatos", () => {
	assert.deepEqual(mentionState("oi @", 4, members)?.candidates.map((m) => m.id), ["ana", "bia", "caio"]);
	assert.deepEqual(mentionState("oi @b", 5, members)?.candidates.map((m) => m.id), ["bia"]);
	assert.equal(mentionState("oi @zz", 6, members), null);
	assert.equal(mentionState("oi bia", 6, members), null);
	assert.equal(mentionState("mail a@b", 8, members), null, "e-mail não abre");
});

test("aplica a menção no lugar da consulta e posiciona o cursor depois do espaço", () => {
	assert.deepEqual(applyMention("oi @bi", 6, 3, "Bia"), { value: "oi @Bia ", caret: 8 });
	assert.deepEqual(applyMention("oi @b e mais", 5, 3, "Bia"), { value: "oi @Bia e mais", caret: 8 });
	assert.deepEqual(applyMention("@c", 2, 0, "Caio Souza"), { value: "@Caio Souza ", caret: 12 });
});

test("setas dão a volta na lista", () => {
	assert.equal(stepMentionIndex(0, 1, 3), 1);
	assert.equal(stepMentionIndex(2, 1, 3), 0);
	assert.equal(stepMentionIndex(0, -1, 3), 2);
	assert.equal(stepMentionIndex(0, 1, 0), 0);
});

const skills = [
	{ id: "pesquisar", name: "pesquisar", description: "Pesquisa na web" },
	{ id: "criar-planilha", name: "criar-planilha", description: "Monta planilhas" },
];
const bots = [
	{ id: "b1", name: "Bia" },
	{ id: "b2", name: "Caio Souza" },
];

test("composer 1:1: / oferece skills e @ oferece outros bots, com estado vazio aberto", () => {
	const slash = triggerState("faz /pe", 7, { skills, bots });
	assert.equal(slash?.trigger, "/");
	assert.equal(slash?.start, 4);
	assert.deepEqual(slash?.candidates.map((c) => c.id), ["pesquisar"]);
	assert.deepEqual(triggerState("/", 1, { skills, bots })?.candidates.map((c) => c.id), ["pesquisar", "criar-planilha"]);
	const at = triggerState("oi @ca", 6, { skills, bots });
	assert.equal(at?.trigger, "@");
	assert.deepEqual(at?.candidates.map((c) => c.id), ["b2"]);
	assert.deepEqual(triggerState("/zzz", 4, { skills, bots })?.candidates, []);
	assert.deepEqual(triggerState("@zzz", 4, { skills, bots: [] })?.candidates, []);
});

test("composer 1:1: não abre em palavra, e-mail, caminho nem texto comum", () => {
	assert.equal(triggerState("a/b", 3, { skills, bots }), null);
	assert.equal(triggerState("email@x", 7, { skills, bots }), null);
	assert.equal(triggerState("https://x", 9, { skills, bots }), null);
	assert.equal(triggerState("oi tudo bem", 11, { skills, bots }), null);
});

test("vale o gatilho mais perto do cursor", () => {
	assert.equal(triggerState("@bia e /pe", 10, { skills, bots })?.trigger, "/");
	assert.equal(triggerState("/pesquisar @bi", 14, { skills, bots })?.trigger, "@");
});

test("aplica / no lugar da consulta e mantém o @ como padrão", () => {
	assert.deepEqual(applyMention("faz /pe", 7, 4, "pesquisar", "/"), { value: "faz /pesquisar ", caret: 15 });
	assert.deepEqual(applyMention("/p resto", 2, 0, "pesquisar", "/"), { value: "/pesquisar resto", caret: 11 });
	assert.deepEqual(applyMention("oi @bi", 6, 3, "Bia", "@"), { value: "oi @Bia ", caret: 8 });
});
