/**
 * Leituras que viram `AgentRun` não trazem o `checkpointJson` (transcrição do modelo, pode passar de MBs):
 * `mapRun` o descarta. Prisma interceptado; sem banco.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { AGENT_RUN_SELECT, getAgentRun, getAgentRunForUser, listRunsForConversation, requestPauseAgentRun } = await import("./runs.js");

const row = {
	id: "r1",
	userId: "u1",
	botId: null,
	conversationId: "c1",
	origin: "chat",
	parentRunId: null,
	objective: "oi",
	status: "running",
	model: "m",
	maxSteps: 10,
	sandboxSessionId: null,
	error: null,
	resultText: null,
	cancelRequested: false,
	budgetJson: null,
	usageJson: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	startedAt: null,
	finishedAt: null,
};

function capture() {
	const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
	const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
	for (const method of ["findUnique", "findFirst"]) {
		agentRun[method] = async (args: Record<string, unknown>) => (calls.push({ method, args }), row);
	}
	agentRun.findMany = async (args: Record<string, unknown>) => (calls.push({ method: "findMany", args }), [row]);
	agentRun.updateMany = async () => ({ count: 1 });
	return calls;
}

test("AGENT_RUN_SELECT cobre o que mapRun usa e deixa o checkpoint de fora", () => {
	assert.equal("checkpointJson" in AGENT_RUN_SELECT, false);
	assert.deepEqual(Object.keys(AGENT_RUN_SELECT).sort(), Object.keys(row).sort());
});

test("getAgentRunForUser: filtra pelo dono e não lê checkpointJson", async () => {
	const calls = capture();
	const run = await getAgentRunForUser("r1", "u1");
	assert.equal(run?.id, "r1");
	assert.deepEqual(calls[0]!.args.where, { id: "r1", userId: "u1" });
	assert.equal(calls[0]!.args.select, AGENT_RUN_SELECT);
	// Usuário vazio ou legado nunca consulta.
	assert.equal(await getAgentRunForUser("r1", "default"), null);
	assert.equal(calls.length, 1);
});

test("getAgentRun, listagem por conversa e pausa usam o select curto", async () => {
	const calls = capture();
	await getAgentRun("r1");
	await listRunsForConversation("c1");
	await requestPauseAgentRun("r1");
	assert.equal(calls.length, 3);
	for (const call of calls) assert.equal(call.args.select, AGENT_RUN_SELECT, call.method);
});
