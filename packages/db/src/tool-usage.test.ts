/** Uso de tools por bot (núcleo por uso do motor v3): só runs do mesmo dono e do mesmo bot, dentro da janela. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { listBotToolUsage } from "./tool-usage.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const step = (id: string, runId: string, name: unknown, type = "tool") => ({ id, runId, type, inputJson: { name, args: { secret: "nunca lido" } } });

let installed: { restore: () => void };

beforeEach(() => {
	installed = installFakes({
		agentRun: new FakeTable([
			{ id: "run-a1", userId: "user-a", botId: "bot-a", createdAt: daysAgo(1) },
			{ id: "run-a2", userId: "user-a", botId: "bot-a", createdAt: daysAgo(10) },
			{ id: "run-old", userId: "user-a", botId: "bot-a", createdAt: daysAgo(40) },
			{ id: "run-other-bot", userId: "user-a", botId: "bot-x", createdAt: daysAgo(1) },
			{ id: "run-b", userId: "user-b", botId: "bot-a", createdAt: daysAgo(1) },
		]),
		agentStep: new FakeTable([
			step("s1", "run-a1", "create_file"),
			step("s2", "run-a1", "create_file"),
			step("s3", "run-a2", "page_create"),
			step("s4", "run-a2", "create_file", "tool_result"),
			step("s5", "run-old", "propose_routine"),
			step("s6", "run-other-bot", "email_send"),
			step("s7", "run-b", "page_share"),
			step("s8", "run-a1", 42),
		]),
	});
});
afterEach(() => installed.restore());

test("conta só passos `tool` dos runs do bot e do dono, nos últimos 30 dias", async () => {
	assert.deepEqual(await listBotToolUsage({ userId: "user-a", botId: "bot-a", now: NOW }), { create_file: 2, page_create: 1 });
});

test("usuário B não vê o uso do bot do usuário A (mesmo botId)", async () => {
	assert.deepEqual(await listBotToolUsage({ userId: "user-b", botId: "bot-a", now: NOW }), { page_share: 1 });
	assert.deepEqual(await listBotToolUsage({ userId: "user-c", botId: "bot-a", now: NOW }), {});
});

test("sem dono real ou sem bot: vazio (legado default não vê nada)", async () => {
	assert.deepEqual(await listBotToolUsage({ userId: "default", botId: "bot-a", now: NOW }), {});
	assert.deepEqual(await listBotToolUsage({ userId: "user-a", botId: " ", now: NOW }), {});
});

test("transcript da conversa devolve o uso congelado do motor v3 (só contagens válidas)", async () => {
	const { getConversationTranscript } = await import("./runs.js");
	installed.restore();
	installed = installFakes({
		agentRun: new FakeTable([
			{
				id: "run-v3",
				userId: "user-a",
				conversationId: "conv-a",
				origin: "chat",
				parentRunId: null,
				createdAt: daysAgo(1),
				finishedAt: null,
				checkpointJson: { llmMessages: [{ role: "user", content: "oi" }], loadedTools: ["web_search"], engineV3: { toolUsage: { create_file: 4, bad: -1, worse: "x" } } },
			},
		]),
	});
	const transcript = await getConversationTranscript("user-a", "conv-a");
	assert.deepEqual(transcript?.toolUsage, { create_file: 4 });
	assert.equal(await getConversationTranscript("user-b", "conv-a"), null);
});
