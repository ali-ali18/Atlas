/**
 * Frescor de resumo (Parte A2) — runner `node:test` porque `@workspace/db`
 * não tem vitest como dependência.
 *
 * Regra: o resumo cobre tudo ANTES da mensagem que disparou o run (última
 * user/assistant). A mensagem nova NÃO precisa estar coberta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	FRESH_SUMMARY_IGNORE_ROLES,
	isSummaryFreshSnapshot,
} from "./summaries.js";

const msg = (id: string, createdAt: string) => ({ id, createdAt });

describe("isSummaryFreshSnapshot", () => {
	it("resumo cobrindo até N-1 + nova msg user N => fresco", () => {
		const latest = {
			snapshotVersion: "msg-2",
			rangeEnd: "2026-09-20T10:01:00.000Z",
		};
		// Ordem desc: a que disparou o run (N) primeiro.
		const recentDesc = [
			msg("msg-3", "2026-09-20T10:02:00.000Z"),
			msg("msg-2", "2026-09-20T10:01:00.000Z"),
			msg("msg-1", "2026-09-20T10:00:00.000Z"),
		];
		assert.equal(isSummaryFreshSnapshot(latest, recentDesc), true);

		// A regra antiga (snapshotVersion == id da ÚLTIMA msg) retornaria null
		// aqui — é exatamente o bug que este teste trava.
		const oldRuleFresh = latest.snapshotVersion === recentDesc[0]?.id;
		assert.equal(oldRuleFresh, false);
	});

	it("rangeEnd cobrindo a penúltima também vale (snapshotVersion antigo)", () => {
		const latest = {
			snapshotVersion: "msg-1",
			rangeEnd: "2026-09-20T10:01:00.000Z",
		};
		const recentDesc = [
			msg("msg-3", "2026-09-20T10:02:00.000Z"),
			msg("msg-2", "2026-09-20T10:01:00.000Z"),
			msg("msg-1", "2026-09-20T10:00:00.000Z"),
		];
		assert.equal(isSummaryFreshSnapshot(latest, recentDesc), true);
	});

	it("resumo defasado (não cobre a penúltima) => estagnado", () => {
		const latest = {
			snapshotVersion: "msg-1",
			rangeEnd: "2026-09-20T10:00:00.000Z",
		};
		const recentDesc = [
			msg("msg-3", "2026-09-20T10:02:00.000Z"),
			msg("msg-2", "2026-09-20T10:01:00.000Z"),
			msg("msg-1", "2026-09-20T10:00:00.000Z"),
		];
		assert.equal(isSummaryFreshSnapshot(latest, recentDesc), false);
	});

	it("sem resumo => nunca fresco", () => {
		assert.equal(
			isSummaryFreshSnapshot(null, [msg("msg-1", "2026-09-20T10:00:00.000Z")]),
			false,
		);
	});

	it("sem penúltima (primeira msg) => latest existente vale", () => {
		const latest = { snapshotVersion: null, rangeEnd: null };
		assert.equal(
			isSummaryFreshSnapshot(latest, [
				msg("msg-1", "2026-09-20T10:00:00.000Z"),
			]),
			true,
		);
	});

	it("ignora system + cards por padrão", () => {
		assert.deepEqual([...FRESH_SUMMARY_IGNORE_ROLES].sort(), [
			"bot-link",
			"bot-profile",
			"chart",
			"code-run",
			"compaction",
			"confirm",
			"file",
			"login",
			"page",
			"provider-fallback",
			"questionnaire",
			"revised-draft",
			"routine",
			"skill",
			"subagents",
			"system",
			"task-list",
			"tool-budget",
		]);
	});
});

describe("findConversationsNeedingSummary", () => {
	it("só agrega conversas com mensagem na janela recente (idle + lookback), não a tabela inteira", async () => {
		const { prisma } = await import("./client.js");
		const { findConversationsNeedingSummary, SUMMARY_SWEEP_LOOKBACK_MS } = await import("./summaries.js");
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const original = (prisma as unknown as Record<string, unknown>).$queryRawUnsafe;
		(prisma as unknown as Record<string, unknown>).$queryRawUnsafe = async (sql: string, ...params: unknown[]) => {
			calls.push({ sql, params });
			return [{ conversationId: "c1", botId: "b1", lastMessageId: "m9", lastMessageAt: new Date(0), messageCount: BigInt(25), snapshotVersion: null, summaryVersion: null }];
		};
		try {
			const rows = await findConversationsNeedingSummary(30 * 60_000, 20, 20);
			assert.deepEqual(rows.map((row) => [row.conversationId, row.messageCount]), [["c1", 25]]);
		} finally {
			(prisma as unknown as Record<string, unknown>).$queryRawUnsafe = original;
		}
		assert.equal(calls.length, 1);
		const { sql, params } = calls[0]!;
		assert.deepEqual(params, [30 * 60_000, 20, 20, SUMMARY_SWEEP_LOOKBACK_MS]);
		// A janela filtra por createdAt antes de qualquer agregação; nada de GROUP BY sobre a tabela toda.
		assert.match(sql, /WITH recent AS \(\s*SELECT DISTINCT "conversationId"\s*FROM conversation_messages\s*WHERE "createdAt" >= NOW\(\) - \(\(\$1::bigint \+ \$4::bigint\)/);
		assert.doesNotMatch(sql, /GROUP BY/);
		assert.ok(SUMMARY_SWEEP_LOOKBACK_MS > 60 * 60_000, "a janela cobre o cooldown de falha (30 min) com folga");
	});
});
