import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import type { WorkerConfig } from "../config.js";
import { createMaintenanceLlm } from "../maintenance-llm.js";
import { processSummaryJob } from "./summary.js";

const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: undefined, openRouterModel: "expensive", summarizerModel: "cheap/sum", agentRunConcurrency: 1 };

function stubPrisma(saved: Array<Record<string, unknown>>): () => void {
	const targets: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
	const set = (delegate: unknown, patch: Record<string, unknown>) => {
		const target = delegate as Record<string, unknown>;
		const original: Record<string, unknown> = {};
		for (const key of Object.keys(patch)) original[key] = target[key];
		Object.assign(target, patch);
		targets.push([target, original]);
	};
	const base = Date.parse("2026-10-01T10:00:00Z");
	const messages = Array.from({ length: 6 }, (_, i) => ({
		id: `m${i}`, conversationId: "c1", role: i % 2 ? "assistant" : "user", content: `fala ${i}`, createdAt: new Date(base + i * 1000),
		origin: null, metaJson: null, userId: "u1", botId: null,
	}));
	set(prisma.agentRun, { findMany: async () => [] });
	set(prisma.conversationSummary, {
		findFirst: async () => null,
		create: async ({ data }: { data: Record<string, unknown> }) => {
			saved.push(data);
			return { id: "s1", createdAt: new Date(), factsJson: null, ...data };
		},
	});
	set(prisma.conversationMessage, { findMany: async () => [...messages].reverse() });
	set(prisma.conversation, { findUnique: async () => ({ userId: "u1" }) });
	return () => targets.forEach(([target, original]) => Object.assign(target, original));
}

const job = () => ({ name: ATLAS_JOB_NAMES.summaryWrite, id: "j1", data: { conversationId: "c1" } }) as never;

test("resumo usa a chave Anthropic da conta (sem OpenRouter no servidor) e registra o sucesso", async () => {
	const saved: Array<Record<string, unknown>> = [];
	const restore = stubPrisma(saved);
	const reports: unknown[] = [];
	const calls: string[] = [];
	try {
		const result = await processSummaryJob(job(), config, {
			llm: (userId) =>
				createMaintenanceLlm(
					{ kind: "summary", config, userId },
					{
						loadConfig: async () => ({ v: 1, models: { maintenance: "anthropic-direct/claude-x" } }) as never,
						hasKey: async (_u, provider) => provider === "anthropic",
						streams: () => ({
							anthropic: (async (params: { model: string }) => {
								calls.push(params.model);
								return { message: { role: "assistant", content: "Resumo da conversa." }, model: params.model };
							}) as never,
							opencodeGo: (async () => ({})) as never,
						}),
						record: async (user, kind, outcome) => void reports.push([user, kind, outcome.ok]),
					},
				),
		});
		assert.equal(result.version, 1);
		assert.deepEqual(calls, ["anthropic-direct/claude-x"]);
		assert.deepEqual(reports, [["u1", "summary", true]]);
		assert.equal(saved.length, 1);
	} finally {
		restore();
	}
});

test("resumo sem nenhuma chave falha com mensagem amigável e registra o erro", async () => {
	const restore = stubPrisma([]);
	const reports: Array<[string, boolean, string | undefined]> = [];
	try {
		await assert.rejects(
			() =>
				processSummaryJob(job(), config, {
					llm: (userId) =>
						createMaintenanceLlm(
							{ kind: "summary", config, userId },
							{
								loadConfig: async () => ({ v: 1 }) as never,
								hasKey: async () => false,
								record: async (_u, _k, outcome) => void reports.push(["summary", outcome.ok, outcome.ok ? undefined : String((outcome.error as Error).message)]),
							},
						),
				}),
			/Nenhuma chave disponível/,
		);
		assert.equal(reports[0]?.[1], false);
		assert.match(reports[0]?.[2] ?? "", /Nenhuma chave/);
	} finally {
		restore();
	}
});
