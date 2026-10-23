import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { createAssistantSegmentRecorder } from "./assistant-segments.js";

const delta = (id: string, text: string): ComputerUseEvent => ({ type: "assistant_delta", id, delta: text });
const toolCall = (id = "t1"): ComputerUseEvent => ({ type: "tool_call", id, name: "browser", args: "{}" });

function setup() {
	const writes: Array<{ text: string; at: number }> = [];
	let clock = 1_000;
	const recorder = createAssistantSegmentRecorder({
		write: async (text, at) => void writes.push({ text, at: at.getTime() }),
		now: () => new Date((clock += 10)),
	});
	return { writes, recorder };
}

test("resposta da triagem é gravada na hora, na ordem da emissão", async () => {
	const { writes, recorder } = setup();
	await recorder.observe(delta("turn-reply1", "O cofre tem o login."));
	await recorder.observe(delta("turn-reply2", "Consigo sim."));
	assert.deepEqual(writes.map((w) => w.text), ["O cofre tem o login.", "Consigo sim."]);
	assert.ok(writes[0]!.at < writes[1]!.at);
});

test("texto de passo com tools sai na chamada da tool, com a hora do primeiro delta", async () => {
	const { writes, recorder } = setup();
	await recorder.observe(delta("s1", "Vou abrir "));
	await recorder.observe(delta("s1", "a página."));
	assert.equal(writes.length, 0);
	await recorder.observe(toolCall());
	assert.deepEqual(writes.map((w) => w.text), ["Vou abrir a página."]);
	assert.equal(writes[0]!.at, 1_010);
});

test("texto do passo final nunca é gravado aqui (o fim do run o grava)", async () => {
	const { writes, recorder } = setup();
	await recorder.observe(delta("s1", "passo com tool"));
	await recorder.observe(toolCall());
	await recorder.observe(delta("s2", "resposta final"));
	assert.deepEqual(writes.map((w) => w.text), ["passo com tool"]);
});

test("assistant_discard retira o texto do passo", async () => {
	const { writes, recorder } = setup();
	await recorder.observe(delta("s1", "rascunho"));
	await recorder.observe({ type: "assistant_discard" });
	await recorder.observe(toolCall());
	assert.equal(writes.length, 0);
});

test("assistant_discard com id retira só o passo dele", async () => {
	const { writes, recorder } = setup();
	await recorder.observe(delta("s1", "Vou abrir o AVA."));
	// Passo seguinte estourou o prazo antes de escrever: o descarte dele não leva a fala do s1.
	await recorder.observe({ type: "assistant_discard", id: "s2", reason: "timeout" });
	await recorder.observe(toolCall());
	assert.deepEqual(writes.map((w) => w.text), ["Vou abrir o AVA."]);
});

test("falha ao gravar não derruba o run", async () => {
	const recorder = createAssistantSegmentRecorder({ write: async () => Promise.reject(new Error("db")) });
	await assert.doesNotReject(recorder.observe(delta("t-reply1", "oi")));
});

test("rascunho revisado é gravado como card recolhido (motivo e hora do 1º delta); fala repetida não", async () => {
	const drafts: Array<{ text: string; reason: string; at: number }> = [];
	const writes: string[] = [];
	let clock = 1_000;
	const recorder = createAssistantSegmentRecorder({
		write: async (text) => void writes.push(text),
		writeDraft: async (text, reason, at) => void drafts.push({ text, reason, at: at.getTime() }),
		now: () => new Date((clock += 10)),
	});
	await recorder.observe(delta("s1", "Pedi pro Bobinho, "));
	await recorder.observe(delta("s1", "te aviso."));
	await recorder.observe({ type: "assistant_discard", id: "s1", reason: "items_open" });
	await recorder.observe(delta("s2", "Vou abrir o AVA."));
	await recorder.observe({ type: "assistant_discard", id: "s2", reason: "duplicate" });
	await recorder.observe(toolCall());
	assert.deepEqual(drafts, [{ text: "Pedi pro Bobinho, te aviso.", reason: "items_open", at: 1_010 }]);
	assert.deepEqual(writes, []);
});
