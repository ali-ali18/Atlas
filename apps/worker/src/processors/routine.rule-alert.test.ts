import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";
import type { AlertRule } from "@workspace/shared";
import { processExecuteRoutineJob } from "./routine.js";

/**
 * Alerta com regra: o servidor lê e avalia sozinho. Sem modelo configurado, sem AgentRun, sem esperar o chat,
 * e a RoutineRun é fechada direto (só do dono).
 */

const config = { redisUrl: "fixture", openRouterApiKey: "fixture", openRouterModel: "fixture/model", summarizerModel: "fixture/model", agentRunConcurrency: 1 };
const now = new Date("2026-10-30T12:00:00Z");
const rule = { source: { type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: ".price" } }, check: { kind: "value", parse: "money", op: "lt", value: 400 }, label: "tênis" };

type Patched = Array<[object, string, unknown]>;
function patch(list: Patched, target: object, key: string, value: unknown) {
	list.push([target, key, Reflect.get(target, key)]);
	Reflect.set(target, key, value);
}

function scenario(input: { alertJson: unknown; chatBusy?: boolean; triggerType?: string; botModel?: string }) {
	const patched: Patched = [];
	const seen = { agentRunCreates: 0, activeRunQueries: 0, runCreates: [] as Array<Record<string, unknown>>, runClosed: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>, alertWrites: [] as Array<Record<string, unknown>>, skipped: [] as Array<Record<string, unknown>> };
	patch(patched, prisma.routine, "findUnique", async () => ({
		id: "r", userId: "user-a", botId: "bot-a", pageId: null, template: null, name: "Tênis", prompt: "confira", enabled: true,
		triggerType: input.triggerType ?? "interval", triggerJson: { kind: "interval", everyMinutes: 120 }, model: null, allowChatgptPlan: false, alertJson: input.alertJson,
	}));
	patch(patched, prisma.bot, "findFirst", async () => ({ id: "bot-a", conversationId: "conv-a", openRouterModel: input.botModel ?? "", policyJson: null, language: "pt-BR" }));
	patch(patched, prisma.routineRun, "findFirst", async ({ where }: { where: Record<string, unknown> }) => (where.id ? { routineId: "r" } : null));
	patch(patched, prisma.routineRun, "findMany", async () => []);
	patch(patched, prisma.routineRun, "create", async ({ data }: { data: Record<string, unknown> }) => {
		seen.runCreates.push(data);
		return { id: "rr", routineId: "r", triggeredBy: "schedule", status: data.status, error: data.error ?? null, createdAt: now, scheduledFor: null, startedAt: null, finishedAt: null, summary: null, agentRunId: null, eventJson: null };
	});
	patch(patched, prisma.routineRun, "updateMany", async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
		seen.runClosed.push({ where, data });
		return { count: 1 };
	});
	patch(patched, prisma.routineRun, "update", async ({ data }: { data: Record<string, unknown> }) => {
		seen.skipped.push(data);
		return { id: "rr", routineId: "r", triggeredBy: "schedule", status: "skipped", error: data.error ?? null, createdAt: now, scheduledFor: null, startedAt: null, finishedAt: null, summary: null, agentRunId: null, eventJson: null };
	});
	patch(patched, prisma.routine, "updateMany", async ({ data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
		if ("alertJson" in data) seen.alertWrites.push(data.alertJson as Record<string, unknown>);
		return { count: 1 };
	});
	patch(patched, prisma.agentRun, "findMany", async () => {
		seen.activeRunQueries += 1;
		return input.chatBusy ? [{ id: "chat-run", userId: "user-a", botId: "bot-a", conversationId: "conv-a", origin: "chat", objective: "x", status: "running", model: "m", maxSteps: 10, sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null }] : [];
	});
	patch(patched, prisma.agentRun, "create", async () => {
		seen.agentRunCreates += 1;
		return { id: "agent-run-1" };
	});
	const queue = { getJob: async () => null, add: async () => undefined } as unknown as Parameters<typeof processExecuteRoutineJob>[2];
	const restore = () => {
		for (const [target, key, original] of patched.reverse()) Reflect.set(target, key, original);
	};
	return { seen, queue, restore };
}

const reader = (text: string | null) => async (_rule: AlertRule) => ({ ok: true as const, read: { kind: "text" as const, text }, host: "loja.example.com", ms: 3 });

test("alerta com regra: lê, avalia e fecha a execução sem AgentRun nem modelo, mesmo com o chat ocupado", async () => {
	const s = scenario({ alertJson: { condition: "o tênis baixar de R$ 400", active: false, rule }, chatBusy: true });
	const posted: string[] = [];
	const pushed: string[] = [];
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, {
			readAlertRule: reader("R$ 389,90"),
			appendMessage: async (_c, text) => void posted.push(text),
			notify: async (_u, _c, _k, text) => void pushed.push(text),
			log: () => undefined,
		});
		assert.equal(result.status, "succeeded");
		assert.equal(result.agentRunId, undefined);
		assert.equal(s.seen.agentRunCreates, 0);
		assert.equal(s.seen.activeRunQueries, 0, "não espera o chat");
		assert.equal(s.seen.runClosed.filter((c) => "routine" in c.where && c.data.status === "succeeded").length, 1);
		assert.equal(s.seen.runClosed.find((c) => c.data.status === "succeeded")?.data.status, "succeeded");
		assert.deepEqual((s.seen.runClosed.find((c) => c.data.status === "succeeded")!.where.routine as { userId: { in: string[] } }).userId, { in: ["user-a"] });
		const state = s.seen.alertWrites[0] as { ruleState?: { lastValue?: number; consecutive?: number }; rule?: unknown };
		assert.deepEqual({ v: state.ruleState?.lastValue, c: state.ruleState?.consecutive }, { v: 389.9, c: 1 });
		assert.deepEqual(state.rule, rule, "a regra segue no estado gravado");
		assert.equal(posted.length + pushed.length, 0, "1ª leitura não avisa (debounce)");
	} finally {
		s.restore();
	}
});

test("alerta com regra avisa na 2ª leitura: aviso na conversa do bot e push", async () => {
	const s = scenario({ alertJson: { condition: "o tênis baixar de R$ 400", active: false, rule, ruleState: { lastValue: 389.9, consecutive: 1 } } });
	const posted: Array<[string, string]> = [];
	const pushed: string[] = [];
	try {
		await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, {
			readAlertRule: reader("R$ 389,90"),
			appendMessage: async (conversationId, text) => void posted.push([conversationId, text]),
			notify: async (_u, _c, kind, text) => void pushed.push(`${kind}:${text}`),
			log: () => undefined,
		});
		assert.deepEqual(posted, [["conv-a", "⚠️ Tênis está em R$ 389,90"]]);
		assert.deepEqual(pushed, ["alert:⚠️ Tênis está em R$ 389,90"]);
	} finally {
		s.restore();
	}
});

test("fonte que falha fecha a execução como concluída com o 'não consegui verificar' (sem entrar nas falhas do diagnóstico)", async () => {
	const s = scenario({ alertJson: { condition: "o tênis baixar de R$ 400", active: false, rule } });
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, {
			readAlertRule: async () => ({ ok: false as const, code: "http", reason: "o site recusou ou falhou (HTTP 403)", host: "loja.example.com", ms: 4 }),
			log: () => undefined,
		});
		assert.equal(result.status, "succeeded");
		const closed = s.seen.runClosed.find((c) => c.data.status === "succeeded");
		assert.match(String(closed?.data.summary), /Não consegui verificar o alerta “Tênis”: o site recusou ou falhou \(HTTP 403\)/);
		assert.equal(closed?.data.error, null);
		assert.equal(s.seen.runClosed.some((c) => c.data.status === "failed"), false);
	} finally {
		s.restore();
	}
});

test("disparo agendado perto demais da última leitura é espaçado (piso da fonte) sem ler nem gastar nada", async () => {
	const recent = new Date(Date.now() - 5 * 60_000).toISOString();
	const s = scenario({ alertJson: { condition: "o tênis baixar de R$ 400", active: false, rule, checkedAt: recent } });
	let reads = 0;
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, {
			readAlertRule: async () => {
				reads += 1;
				return { ok: true as const, read: { kind: "text" as const, text: "1" }, host: "x", ms: 1 };
			},
			log: () => undefined,
		});
		assert.equal(result.status, "skipped");
		assert.equal(reads, 0);
		assert.match(String(s.seen.runCreates[0]?.error), /Espaçado/);
	} finally {
		s.restore();
	}
});

test("alerta sem regra segue o caminho do modelo (controle): não lê a fonte nem fecha a execução direto", async () => {
	const s = scenario({ alertJson: { condition: "o estoque da canela cair abaixo de 10", active: false }, botModel: "openrouter/x" });
	let reads = 0;
	try {
		await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, {
			readAlertRule: async () => {
				reads += 1;
				return { ok: true as const, read: { kind: "text" as const, text: "x" }, host: "x", ms: 1 };
			},
			log: () => undefined,
		});
		assert.equal(reads, 0);
		assert.equal(s.seen.runClosed.filter((c) => c.data.status === "succeeded" || c.data.status === "failed").length, 0);
	} finally {
		s.restore();
	}
});
