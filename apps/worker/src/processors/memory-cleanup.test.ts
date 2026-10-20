import assert from "node:assert/strict";
import { test } from "node:test";
import { ATLAS_JOB_NAMES, type MemoryCleanupSuggestion } from "@workspace/shared";
import type { MemoryGateDeps } from "@workspace/agent-runtime";
import type { WorkerConfig } from "../config.js";
import { buildMemoryGateDeps } from "../memory-gate.js";
import { processMemoryCleanup, type MemoryCleanupDeps } from "./memory-cleanup.js";

const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: "test", openRouterModel: "expensive", summarizerModel: "cheap", agentRunConcurrency: 1 };
const job = { name: ATLAS_JOB_NAMES.memoryCleanup, id: "job", data: { userId: "u1", botId: "b1" } } as const;
const quiet: Pick<MemoryGateDeps, "log"> = { log: () => undefined };

const layer = (entries: Array<[string, string]>) => ({ entries: entries.map(([id, content]) => ({ id, content })), usage: { used: 0, limit: 1 } });
const snapshot = async () =>
	({
		user: layer([["u-1", "Mora em Curitiba"]]),
		memory: layer([
			["m-1", "Reunião de hoje remarcada"],
			["m-2", "Prefere planilha"],
			["m-3", "Gosta de planilha xlsx"],
		]),
	}) as never;

function harness(gate: MemoryGateDeps, over: Partial<MemoryCleanupDeps> = {}) {
	const mutations: string[] = [];
	const saved: MemoryCleanupSuggestion[][] = [];
	const failed: string[] = [];
	let n = 0;
	const deps: MemoryCleanupDeps = {
		snapshot,
		gate: async () => gate,
		owns: async () => true,
		save: async (_u, _b, list) => void saved.push(list),
		fail: async (_u, _b, message) => void failed.push(message),
		newId: () => `s${++n}`,
		now: () => new Date("2026-10-20T12:00:00Z"),
		...over,
	};
	return { deps, saved, failed, mutations };
}

test("limpeza: Jev classifica, o modelo escreve a fusão; só grava SUGESTÕES, nunca mexe nas memórias", async () => {
	// O snapshot é só leitura aqui: nenhuma porta de escrita de memória existe nas dependências.
	const answers: Record<string, number> = { useful_0: 0.05, redundant_1: 0.9, redundant_2: 0.9 };
	const h = harness({
		...quiet,
		// Só a camada do bot tem entradas de interesse; a do usuário (uma entrada) passa limpa.
		ask: async ({ questions, state }) => {
			const own = (state as { entries: unknown[] }).entries.length > 1;
			return { model: "fake", durationMs: 0, answers: Object.fromEntries(Object.keys(questions).map((key) => [key, own ? (answers[key] ?? (key.startsWith("redundant") ? 0 : 1)) : key.startsWith("redundant") ? 0 : 1])) };
		},
		complete: async () => JSON.stringify({ merge: [{ entries: [1, 2], content: "Prefere planilha (xlsx)", reason: "mesmo assunto" }] }),
	});
	const result = await processMemoryCleanup(job, config, h.deps);
	assert.deepEqual(result, { status: "done", suggestions: 2 });
	assert.equal(h.saved.length, 1);
	assert.deepEqual(h.saved[0], [
		{ id: "s1", kind: "delete", target: "memory", entryIds: ["m-1"], before: ["Reunião de hoje remarcada"], reason: "não muda o que o bot faria depois", createdAt: "2026-10-20T12:00:00.000Z" },
		{ id: "s2", kind: "merge", target: "memory", entryIds: ["m-2", "m-3"], before: ["Prefere planilha", "Gosta de planilha xlsx"], content: "Prefere planilha (xlsx)", reason: "mesmo assunto", createdAt: "2026-10-20T12:00:00.000Z" },
	]);
	assert.deepEqual(h.failed, []);
});

test("limpeza: as duas camadas são revisadas (memory e user) e o alvo fica na sugestão", async () => {
	const seen: string[] = [];
	const h = harness({
		...quiet,
		complete: async ({ user }) => {
			const entries = JSON.parse(user).entries as Array<{ content: string }>;
			seen.push(entries.map((entry) => entry.content).join("|"));
			return JSON.stringify({ delete: entries.some((entry) => entry.content === "Mora em Curitiba") ? [{ n: 0, reason: "vago" }] : [] });
		},
	});
	const result = await processMemoryCleanup(job, config, h.deps);
	assert.equal(seen.length, 2);
	assert.equal(result.status, "done");
	assert.deepEqual(h.saved[0]!.map((s) => [s.target, s.entryIds]), [["user", ["u-1"]]]);
});

test("limpeza: sem nenhum caminho de LLM vira falha visível (não grava sugestões)", async () => {
	const h = harness({ ...quiet });
	const result = await processMemoryCleanup(job, config, h.deps);
	assert.equal(result.status, "failed");
	assert.equal(h.saved.length, 0);
	assert.equal(h.failed.length, 1);
	assert.match(h.failed[0]!, /\S/);
});

test("limpeza: bot que não é do usuário é pulado; nome de job errado lança", async () => {
	const h = harness({ ...quiet }, { owns: async () => false });
	assert.deepEqual(await processMemoryCleanup(job, config, h.deps), { status: "skipped", reason: "bot não encontrado" });
	await assert.rejects(processMemoryCleanup({ ...job, name: "memory.review" } as never, config, h.deps));
});

test("porteiro do worker: com Jev desligado (padrão) só o modelo de manutenção entra; Jev ligado + revisor disponível entra o Jev", async () => {
	const llm = async () => ({ candidates: [{}], model: "m", complete: async () => ({ message: { content: "{}" }, model: "m" }), report: async () => undefined }) as never;
	const off = await buildMemoryGateDeps({ userId: "u1", config }, { loadConfig: async () => ({ v: 1 }) as never, env: {}, llm });
	assert.equal(off.ask, undefined);
	assert.equal(typeof off.complete, "function");
	const on = await buildMemoryGateDeps(
		{ userId: "u1", config },
		{
			loadConfig: async () => ({ v: 1, jev: { features: { memory: "on" } } }) as never,
			env: {},
			llm,
			reviewer: { loadConfig: async () => ({ v: 1 }) as never, hasKey: async () => false },
		},
	);
	assert.equal(typeof on.ask, "function");
	const none = await buildMemoryGateDeps({ userId: "u1", config }, { loadConfig: async () => ({ v: 1 }) as never, env: {}, llm: async () => ({ candidates: [] }) as never });
	assert.equal(none.complete, undefined);
});
