import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateAgentRunRequest } from "@workspace/shared";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-reaction-only";
const { maybeReactOnly } = await import("./reaction-only.js");
type Deps = Parameters<typeof maybeReactOnly>[0]["deps"];

const NOW = new Date("2026-10-17T12:00:00Z");
const calm = { isGroup: false, hasActiveRun: false, hasPendingCard: false, previous: { role: "assistant", text: "Enviei o relatório.", at: new Date("2026-10-17T11:55:00Z") } };

function setup(over: { state?: Record<string, unknown>; enabled?: boolean; jevMode?: "off" | "shadow" | "on"; detect?: Deps["detect"]; getStateThrows?: boolean; recordNull?: boolean } = {}) {
	const calls = { state: 0, detect: 0, record: [] as Array<{ content: string; emoji: string }> };
	const deps: Deps = {
		loadSettings: async () => ({ enabled: over.enabled ?? true, jevMode: over.jevMode ?? "off" }),
		getState: async () => {
			calls.state += 1;
			if (over.getStateThrows) throw new Error("db down");
			return { ...calm, ...over.state } as Awaited<ReturnType<Deps["getState"]>>;
		},
		detect: async (input) => {
			calls.detect += 1;
			return over.detect ? over.detect(input) : "👍";
		},
		record: async (input) => {
			calls.record.push({ content: input.content, emoji: input.emoji });
			return over.recordNull ? null : { messageId: "m1", emoji: input.emoji };
		},
		now: () => NOW,
	};
	return { deps, calls };
}
const req = (text: string, over: Partial<CreateAgentRunRequest> = {}): CreateAgentRunRequest => ({
	messages: [{ role: "user", content: text }],
	conversationId: "c1",
	botId: "b1",
	...over,
});

test("camada 1: valeu! vira ❤️ sem consultar o Jev", async () => {
	const { deps, calls } = setup({ jevMode: "on" });
	const out = await maybeReactOnly({ request: req("valeu!"), userId: "u", deps });
	assert.ok(out.handled);
	if (out.handled) assert.deepEqual(out.response, { runId: null, status: "reacted", enqueued: true, messageId: "m1", reaction: "❤️" });
	assert.deepEqual(calls.record, [{ content: "valeu!", emoji: "❤️" }]);
	assert.equal(calls.detect, 0);
});

test("pedidos e perguntas seguem o fluxo normal sem tocar no banco", async () => {
	for (const text of ["ok, manda o relatório", "valeu, e o estoque?", "ok?", "qual o saldo", "preciso de ajuda com o pedido 123"]) {
		const { deps, calls } = setup({ jevMode: "on" });
		const out = await maybeReactOnly({ request: req(text), userId: "u", deps });
		assert.equal(out.handled, false, text);
		assert.equal(calls.state, 0, text);
		assert.equal(calls.detect, 0, text);
	}
});

test("travas: cartão pendente, run ativo, grupo, pergunta anterior, anexo, origem, conta desligada", async () => {
	const blocked: Array<[string, ReturnType<typeof setup>, Partial<CreateAgentRunRequest>?]> = [
		["cartão pendente", setup({ state: { hasPendingCard: true } })],
		["run ativo", setup({ state: { hasActiveRun: true } })],
		["grupo", setup({ state: { isGroup: true } })],
		["pergunta anterior", setup({ state: { previous: { role: "assistant", text: "Posso enviar?", at: new Date("2026-10-17T11:58:00Z") } } })],
		["sem fala anterior", setup({ state: { previous: null } })],
		["anexo", setup(), { attachments: [{ artifactId: "a1" }] }],
		["origem rotina", setup(), { origin: "routine" }],
		["clique de cartão", setup(), { decisionConfirmId: "x" }],
		["run silencioso", setup(), { silent: true }],
		["objetivo próprio", setup(), { objective: "outra coisa" }],
		["conta desligada", setup({ enabled: false })],
	];
	for (const [label, { deps, calls }, patch] of blocked) {
		const out = await maybeReactOnly({ request: req("ok", patch), userId: "u", deps });
		assert.equal(out.handled, false, label);
		assert.equal(calls.record.length, 0, label);
	}
});

test("camada 2: ambígua curta só com Jev ligado e sim confiante; o emoji é do conjunto", async () => {
	const off = setup({ jevMode: "off" });
	assert.equal((await maybeReactOnly({ request: req("boa essa"), userId: "u", deps: off.deps })).handled, false);
	assert.equal(off.calls.detect, 0);

	const on = setup({ jevMode: "on", detect: async () => "😂" });
	const out = await maybeReactOnly({ request: req("boa essa"), userId: "u", deps: on.deps });
	assert.ok(out.handled);
	assert.deepEqual(on.calls.record, [{ content: "boa essa", emoji: "😂" }]);

	const unsure = setup({ jevMode: "on", detect: async () => null });
	assert.equal((await maybeReactOnly({ request: req("boa essa"), userId: "u", deps: unsure.deps })).handled, false);
});

test("falhas viram fluxo normal: Jev lança, leitura do banco falha, gravação recusa", async () => {
	const jevThrows = setup({ jevMode: "on", detect: async () => { throw new Error("timeout"); } });
	assert.equal((await maybeReactOnly({ request: req("boa essa"), userId: "u", deps: jevThrows.deps })).handled, false);
	const dbDown = setup({ getStateThrows: true });
	assert.equal((await maybeReactOnly({ request: req("ok"), userId: "u", deps: dbDown.deps })).handled, false);
	const raced = setup({ recordNull: true });
	assert.equal((await maybeReactOnly({ request: req("ok"), userId: "u", deps: raced.deps })).handled, false);
});
