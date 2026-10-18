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
			"confirm",
			"file",
			"login",
			"provider-fallback",
			"questionnaire",
			"routine",
			"skill",
			"subagents",
			"system",
			"tool-budget",
		]);
	});
});
