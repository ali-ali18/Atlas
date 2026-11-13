/**
 * Cartão dos subagentes do v4 no worker (F9) com db falso: eventos ao vivo com os mesmos tipos do motor antigo, mensagem
 * `subagents` gravada UMA vez por groupId (mesma identidade do vivo), só com conversa, e falha de banco não derruba o run.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/subagents.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { createV4Subagents, type V4SubagentsDeps } from "./subagents.js";

const task = (over: Record<string, unknown> = {}) => ({ taskIndex: 0, goal: "Ache o preço", status: "ok" as const, summary: "Custa 10", toolsUsed: ["web_extract"], ...over });

function rig(conversationId: string | null = "conv-1", fail = false) {
	const live: ComputerUseEvent[] = [];
	const saved: Array<{ conversationId: string; card: unknown }> = [];
	const logs: string[] = [];
	const deps: V4SubagentsDeps = {
		saveCard: async (id, card) => {
			if (fail) throw new Error("db fora do ar");
			saved.push({ conversationId: id, card });
		},
	};
	const cards = createV4Subagents({ scope: { conversationId, emit: (e) => void live.push(e), log: (m) => void logs.push(m) }, deps });
	return { cards, live, saved, logs };
}

test("emite subagent_started, subagent_tool e subagent_done com os campos do contrato do motor antigo", async () => {
	const { cards, live } = rig();
	await cards.started("u", "r", { groupId: "g1", taskIndex: 0, goal: "Ache o preço", title: "Loja A", childRunId: "r:helper:1" });
	await cards.tool("u", "r", { groupId: "g1", taskIndex: 0, childRunId: "r:helper:1", name: "web_extract", ok: true });
	await cards.done("u", "r", { groupId: "g1", taskIndex: 0, childRunId: "r:helper:1", status: "partial", summary: "parcial", toolsUsed: ["web_extract"], title: "Loja A" });
	assert.deepEqual(live, [
		{ type: "subagent_started", groupId: "g1", taskIndex: 0, goal: "Ache o preço", title: "Loja A", childRunId: "r:helper:1" },
		{ type: "subagent_tool", groupId: "g1", taskIndex: 0, childRunId: "r:helper:1", name: "web_extract", ok: true },
		{ type: "subagent_done", groupId: "g1", taskIndex: 0, childRunId: "r:helper:1", status: "partial", summary: "parcial", toolsUsed: ["web_extract"], title: "Loja A" },
	]);
});

test("grava a mensagem `subagents` na conversa do run, uma vez por groupId", async () => {
	const { cards, saved } = rig();
	await cards.save("u", "r", "g1", [task()]);
	await cards.save("u", "r", "g1", [task()]);
	await cards.save("u", "r", "g2", [task({ status: "failed", summary: "falhou" })]);
	assert.equal(saved.length, 2);
	assert.deepEqual(saved[0], { conversationId: "conv-1", card: { v: 1, kind: "subagents", groupId: "g1", tasks: [task()] } });
	assert.equal(saved[1]?.conversationId, "conv-1");
});

test("sem conversa nada é gravado (o vivo continua); falha de banco vai ao log e não lança", async () => {
	const none = rig(null);
	await none.cards.save("u", "r", "g1", [task()]);
	assert.equal(none.saved.length, 0);
	const broken = rig("conv-1", true);
	await broken.cards.save("u", "r", "g1", [task()]);
	assert.match(broken.logs[0] ?? "", /subagents/);
});
