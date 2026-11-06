/**
 * Agendador do sono (F5.3) com banco e modelo falsos.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/sleep-sweeper.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SleepBotRef } from "@workspace/db";
import type { EngineV4Gate } from "@workspace/shared";
import { SUBMIT_SLEEP_TOOL } from "./sleep-prompt.js";
import { sleepTick, type SleepSweepDeps } from "./sleep-sweeper.js";
import type { SleepPorts } from "./sleep-run.js";

const bot = (id: string, ownerId: string, over: Partial<SleepBotRef> = {}): SleepBotRef => ({ id, ownerId, name: id, language: "pt-BR", conversationId: `c-${id}`, policyJson: null, ...over });

function harness(input: { bots: SleepBotRef[]; zones?: Record<string, string>; gate?: EngineV4Gate; now: string; taken?: Set<string>; failBots?: Set<string>; failAfterModel?: Set<string> }) {
	const log: string[] = [];
	const finished: Array<{ id: string; status: string; windowEnd?: Date; detail?: string; stats?: Record<string, number> }> = [];
	const claims: string[] = [];
	const listed: string[][] = [];
	const windows: Array<{ bot: string; from: Date; to: Date }> = [];
	const deps: SleepSweepDeps = {
		gate: () => input.gate ?? { enabled: true, accounts: ["u1", "u2"] },
		now: () => new Date(input.now),
		log: (line) => void log.push(line),
		db: {
			listBots: async (owners) => (listed.push([...owners]), input.bots.filter((b) => owners.includes(b.ownerId))),
			timezoneOf: async (userId) => input.zones?.[userId] ?? "America/Sao_Paulo",
			claim: async (c) => {
				const key = `${c.botId}:${c.kind}:${c.slot}`;
				claims.push(key);
				if (input.taken?.has(key)) return null;
				return { id: `rep:${key}` };
			},
			finish: (async (f: { id: string; status: string; windowEnd?: Date; detail?: string; stats?: Record<string, number> }) => void finished.push({ id: f.id, status: f.status, ...(f.windowEnd && { windowEnd: f.windowEnd }), ...(f.detail && { detail: f.detail }), ...(f.stats && { stats: f.stats }) })) as unknown as SleepSweepDeps["db"]["finish"],
			previousEnd: async () => null,
		},
		portsFor: async (b) => {
			if (input.failBots?.has(b.id)) throw new Error("sem chave do provedor");
			const late = input.failAfterModel?.has(b.id) ?? false;
			const ports: SleepPorts & { memory: () => Promise<[]>; notes: () => Promise<[]> } = {
				llm: { contextWindow: async () => 1, async *chat() { yield { type: "tool_call", call: { id: "c", name: SUBMIT_SLEEP_TOOL, args: { facts: late ? [{ layer: "owner", content: "Mora em Curitiba", sources: ["m1"] }] : [], notes: [], skills: [] } } }; yield { type: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, ...(late && { costUsd: 0.002 }) }, served: { provider: "p", model: "m" } }; } },
				loadDay: async (w) => (windows.push({ bot: b.id, ...w }), { messages: [{ id: "m1", role: "user", content: "oi", origin: null }], runs: [], notes: [] }),
				existingFacts: async () => [],
				addFact: async () => {
					if (late) throw new Error("banco indisponível");
					return { status: "added" };
				},
				addNote: async () => ({ status: "added" }),
				memory: async () => [],
				notes: async () => [],
			};
			return ports;
		},
	};
	return { deps, log, finished, claims, listed, windows };
}

// 02:31Z de 05/11 = 23:31 de 04/11 em São Paulo (depois das 23:30).
const AFTER = "2026-11-05T02:31:00Z";
const BEFORE = "2026-11-05T02:20:00Z";

test("sem a flag do v4 o passo não consulta o banco", async () => {
	const h = harness({ bots: [bot("b1", "u1")], gate: { enabled: false, accounts: ["u1"] }, now: AFTER });
	await sleepTick(h.deps, new Set());
	assert.deepEqual([h.listed.length, h.claims.length], [0, 0]);
	const none = harness({ bots: [bot("b1", "u1")], gate: { enabled: true, accounts: [] }, now: AFTER });
	await sleepTick(none.deps, new Set());
	assert.equal(none.listed.length, 0);
});

test("só as contas da lista dormem", async () => {
	const h = harness({ bots: [bot("b1", "u1"), bot("b9", "u9")], gate: { enabled: true, accounts: ["u1"] }, now: AFTER });
	await sleepTick(h.deps, new Set());
	assert.deepEqual(h.listed, [["u1"]]);
	assert.deepEqual(h.claims, ["b1:daily:2026-11-04"]);
});

test("antes das 23:30 do fuso do dono não reserva nada; depois, dorme uma vez e a janela termina no slot", async () => {
	const early = harness({ bots: [bot("b1", "u1")], now: BEFORE });
	await sleepTick(early.deps, new Set());
	assert.deepEqual(early.claims, []);

	const h = harness({ bots: [bot("b1", "u1")], now: AFTER });
	const done = new Set<string>();
	await sleepTick(h.deps, done);
	assert.deepEqual(h.claims, ["b1:daily:2026-11-04"]);
	assert.deepEqual(h.finished.map((f) => [f.id, f.status, f.windowEnd?.toISOString()]), [["rep:b1:daily:2026-11-04", "done", "2026-11-05T02:30:00.000Z"]]);
	assert.equal(h.windows[0]?.from.toISOString(), "2026-11-04T02:30:00.000Z", "primeira vez: 24 h antes do slot");
	// Outro passo no mesmo processo: nem tenta a reserva de novo.
	await sleepTick(h.deps, done);
	assert.equal(h.claims.length, 1);
});

test("o fuso é do dono: o mesmo instante é tarde em São Paulo e cedo em Tóquio", async () => {
	const h = harness({ bots: [bot("b1", "u1"), bot("b2", "u2")], zones: { u2: "Asia/Tokyo" }, now: AFTER });
	await sleepTick(h.deps, new Set());
	assert.deepEqual(h.claims, ["b1:daily:2026-11-04"]);
});

test("outro worker já reservou: este não executa", async () => {
	const h = harness({ bots: [bot("b1", "u1")], now: AFTER, taken: new Set(["b1:daily:2026-11-04"]) });
	await sleepTick(h.deps, new Set());
	assert.deepEqual([h.claims.length, h.finished.length, h.windows.length], [1, 0, 0]);
});

test("domingo: depois do sono diário vem o doctor semanal do mesmo bot", async () => {
	// 09/11 02:31Z = domingo 08/11 23:31 em São Paulo.
	const h = harness({ bots: [bot("b1", "u1")], now: "2026-11-09T02:31:00Z" });
	await sleepTick(h.deps, new Set());
	assert.deepEqual(h.claims, ["b1:daily:2026-11-08", "b1:doctor:2026-11-08"]);
	assert.deepEqual(h.finished.map((f) => f.status), ["done", "done"]);
	// Dia comum: sem doctor.
	const weekday = harness({ bots: [bot("b1", "u1")], now: AFTER });
	await sleepTick(weekday.deps, new Set());
	assert.deepEqual(weekday.claims, ["b1:daily:2026-11-04"]);
});

test("o dono desliga o sono por bot (policyJson.sleep = false)", async () => {
	const h = harness({ bots: [bot("b1", "u1", { policyJson: { sleep: false } }), bot("b2", "u1")], now: AFTER });
	await sleepTick(h.deps, new Set());
	assert.deepEqual(h.claims, ["b2:daily:2026-11-04"]);
});

test("a falha de um bot vira relatório falho sem avançar a janela e não impede os outros", async () => {
	const h = harness({ bots: [bot("b1", "u1"), bot("b2", "u1")], now: AFTER, failBots: new Set(["b1"]) });
	await sleepTick(h.deps, new Set());
	const failed = h.finished.find((f) => f.id.includes("b1"));
	assert.deepEqual([failed?.status, failed?.windowEnd, failed?.detail], ["failed", undefined, "sem chave do provedor"]);
	assert.equal(h.finished.find((f) => f.id.includes("b2"))?.status, "done");
	assert.ok(h.log.some((line) => line.includes("bot=b1") && line.includes("falhou")));
});

test("relatório falho guarda o gasto do modelo até a falha (C1)", async () => {
	const h = harness({ bots: [bot("b1", "u1")], now: AFTER, failAfterModel: new Set(["b1"]) });
	await sleepTick(h.deps, new Set());
	const failed = h.finished.find((f) => f.id.includes("b1"));
	assert.equal(failed?.status, "failed");
	assert.deepEqual([failed?.stats?.llmCalls, failed?.stats?.costUsd], [1, 0.002]);
});

test("reserva que lança não perde o dia: o bot tenta de novo no passo seguinte e os outros bots seguem (auditoria F5, B1/R2)", async () => {
	const h = harness({ bots: [bot("b1", "u1"), bot("b2", "u1")], now: AFTER });
	const claim = h.deps.db.claim;
	let broke = true;
	h.deps.db.claim = async (c) => {
		if (broke && c.botId === "b1") throw new Error("banco fora do ar");
		return claim(c);
	};
	const done = new Set<string>();
	await sleepTick(h.deps, done);
	assert.deepEqual(h.claims, ["b2:daily:2026-11-04"]);
	assert.ok(h.log.some((line) => line.includes("bot=b1") && line.includes("reserva falhou")));
	broke = false;
	await sleepTick(h.deps, done);
	assert.deepEqual(h.claims, ["b2:daily:2026-11-04", "b1:daily:2026-11-04"]);
	assert.deepEqual(h.finished.map((f) => [f.id, f.status]), [["rep:b2:daily:2026-11-04", "done"], ["rep:b1:daily:2026-11-04", "done"]]);
});
