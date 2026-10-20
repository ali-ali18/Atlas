import assert from "node:assert/strict";
import { test } from "node:test";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import type { MemoryGateCandidate, MemoryGateVerdict, MemoryJudge } from "@workspace/agent-runtime";
import type { WorkerConfig } from "../config.js";
import { executeMemoryTool, gateCandidates, processMemoryReview, type MemoryOps } from "./memory-review.js";

const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: "test", openRouterModel: "expensive", summarizerModel: "cheap", agentRunConcurrency: 1 };

function fakeOps() {
	const calls: string[] = [];
	const ops = {
		addMemoryEntry: async (input: { content: string }) => (calls.push(`add:${input.content}`), { ok: true }),
		replaceMemoryEntry: async (input: { ref?: string; content: string }) => (calls.push(`replace:${input.ref ? "ref" : "-"}:${input.content}`), { ok: true }),
		removeMemoryEntry: async () => (calls.push("remove"), { ok: true }),
	} as unknown as MemoryOps;
	return { calls, ops };
}

const add = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ action: "add", target: "memory", content, category: "trabalho", ...extra });

test("porteiro: descartar não grava e volta como pulado com o motivo", async () => {
	const { calls, ops } = fakeOps();
	const out = await executeMemoryTool(add("Reunião remarcada"), { userId: "u1", botId: "b1" }, ops, {}, { action: "discard", reason: "já concluído" });
	assert.deepEqual(calls, []);
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { ok: true, skipped: true, reason: "porteiro: já concluído" });
});

test("porteiro: merge troca o add por replace pela ref; sem veredito grava direto; remove ignora o veredito", async () => {
	const merge: MemoryGateVerdict = { action: "merge", entryId: "e1", oldText: "velho", content: "texto fundido" };
	const a = fakeOps();
	await executeMemoryTool(add("novo"), { userId: "u1", botId: "b1" }, a.ops, {}, merge);
	assert.deepEqual(a.calls, ["replace:ref:texto fundido"]);
	const b = fakeOps();
	await executeMemoryTool(add("novo"), { userId: "u1", botId: "b1" }, b.ops, {});
	assert.deepEqual(b.calls, ["add:novo"]);
	const c = fakeOps();
	await executeMemoryTool(JSON.stringify({ action: "remove", target: "memory", old_text: "x" }), { userId: "u1", botId: "b1" }, c.ops, {}, { action: "discard", reason: "x" });
	assert.deepEqual(c.calls, ["remove"]);
});

test("porteiro: candidatos só de add/replace que passaram pela trava de escopo, com o alvo rebaixado", () => {
	const calls = [
		{ id: "1", function: { arguments: add("Fato útil") } },
		{ id: "2", function: { arguments: JSON.stringify({ action: "remove", target: "memory", old_text: "x" }) } },
		{ id: "3", function: { arguments: JSON.stringify({ action: "add", target: "memory", content: "Quer uma rotina diária para consultar agenda às 7h" }) } },
		{ id: "4", function: { arguments: JSON.stringify({ action: "replace", target: "user", content: "Cliente paga dia 10", category: "financas", importance: 0.9 }) } },
	];
	const map = gateCandidates(calls, true, {});
	assert.deepEqual([...map.keys()], ["1", "4"]);
	assert.equal(map.get("4")?.target, "memory");
	assert.equal(map.get("4")?.replaces, true);
	assert.equal(map.get("4")?.importance, 0.9);
});

function toolCallReply(contents: string[]) {
	return {
		model: "cheap",
		message: { role: "assistant", content: "", tool_calls: contents.map((content, i) => ({ id: `c${i}`, type: "function", function: { name: "memory", arguments: add(content) } })) },
	};
}

test("revisão: os fatos do passo vão ao porteiro numa só chamada e cada veredito vale para o seu fato", async () => {
	const { calls, ops } = fakeOps();
	const batches: MemoryGateCandidate[][] = [];
	const judge: MemoryJudge = async ({ candidates }) => (batches.push(candidates), [{ action: "discard", reason: "trivial" }, { action: "save" }]);
	let step = 0;
	const result = await processMemoryReview({ name: ATLAS_JOB_NAMES.memoryReview, id: "job", data: { userId: "u1", botId: "b1", messages: [{ role: "user", content: "oi" }] } }, config, {
		profile: async () => null,
		bots: async () => [],
		snapshot: async () => ({ user: { entries: [] }, memory: { entries: [{ id: "e1", content: "algo antigo" }] } }),
		complete: async () => (step++ === 0 ? (toolCallReply(["Fato trivial", "Cliente paga dia 10"]) as never) : ({ model: "cheap", message: { role: "assistant", content: "" } } as never)),
		judge,
		ops,
	});
	assert.equal(batches.length, 1);
	assert.deepEqual(batches[0]!.map((c) => c.content), ["Fato trivial", "Cliente paga dia 10"]);
	assert.deepEqual(calls, ["add:Cliente paga dia 10"]);
	assert.equal(result.saved, 1);
});

test("revisão: porteiro com erro grava como antes (fail-open)", async () => {
	const { calls, ops } = fakeOps();
	let step = 0;
	const result = await processMemoryReview({ name: ATLAS_JOB_NAMES.memoryReview, id: "job", data: { userId: "u1", botId: "b1", messages: [{ role: "user", content: "oi" }] } }, config, {
		profile: async () => null,
		bots: async () => [],
		snapshot: async () => ({ user: { entries: [] }, memory: { entries: [] } }),
		complete: async () => (step++ === 0 ? (toolCallReply(["Cliente paga dia 10"]) as never) : ({ model: "cheap", message: { role: "assistant", content: "" } } as never)),
		judge: async () => {
			throw new Error("down");
		},
		ops,
	});
	assert.deepEqual(calls, ["add:Cliente paga dia 10"]);
	assert.equal(result.saved, 1);
});
