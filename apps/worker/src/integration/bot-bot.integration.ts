/**
 * Bot→bot no motor v2: Postgres real, modelo roteirizado, runs criados pelo outbox real (`processBotMessages`) e
 * processados pelo `processAgentRunJob` real. Bot A (v2) pede ao bot B (v2); B responde, A é acordado com a resposta;
 * o anti-loop do db (profundidade da cadeia e máximo de envios por run) vale igual ao v1.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import { createApi, createFixture, createUser, installFakeLlm, prisma, processRun, promptOf, sendChat, snapshot, type FakeLlm, type LlmRequest, type ScriptEntry } from "./harness.js";

let llm: FakeLlm | undefined;
afterEach(() => {
	llm?.restore();
	llm = undefined;
});
// Restos de outras execuções no mesmo banco não podem entrar no despacho deste arquivo.
before(async () => {
	if (integrationSkip) return;
	await prisma.botMessage.updateMany({ where: { status: { in: ["pending", "delivering", "delivered", "waiting", "replied", "replying", "reply_delivered"] } }, data: { status: "closed" } });
});

const policy = { engine: "v2", engineScope: "all" };

/** Anda o outbox de mensagens entre bots (entrega, resposta, acordar o remetente) e processa os runs do dono. */
async function driveBots(userId: string, maxPasses = 14): Promise<string[]> {
	const { processBotMessages } = await import("@workspace/db");
	const processed: string[] = [];
	for (let pass = 0; pass < maxPasses; pass++) {
		const queued: string[] = [];
		const result = await processBotMessages({ enqueueRun: async (runId) => { queued.push(runId); return true; }, envDefaultModel: "test/model", resolveModel: async () => "test/model" });
		for (const runId of queued) {
			const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { userId: true } });
			if (run.userId !== userId) continue;
			await processRun(runId);
			processed.push(runId);
		}
		if (queued.length === 0 && !result.inFlight) break;
	}
	return processed;
}

async function twoBots() {
	const userId = await createUser("bot-bot");
	const ana = await createFixture({ userId, name: "Ana", isPrimary: true, policy });
	const bia = await createFixture({ userId, name: "Bia", policy });
	return { userId, ana, bia };
}

/** O prompt do run diz quem é o bot ("You are \"Bia\""). */
const isBot = (request: LlmRequest, name: string) => request.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes(`You are "${name}"`));

describe("bot→bot no v2", { skip: integrationSkip }, () => {
	test("A (v2) pede ao B (v2), B responde e A relata a resposta; o B vê send_to_bot", async () => {
		const { userId, ana, bia } = await twoBots();
		const script: ScriptEntry[] = [
			{ tools: [{ name: "send_to_bot", args: { bot: "Bia", message: "Qual o saldo da conta?", title: "Saldo" } }] },
			{ content: "Pedi o saldo para a Bia, te aviso." },
			{ content: "O saldo é R$ 10,00." },
			{ content: "A Bia respondeu: o saldo é R$ 10,00." },
		];
		llm = installFakeLlm(script);
		const { app } = await createApi(userId);
		const sent = await sendChat(app, ana, "Peça o saldo para a Bia");
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		await processRun(sent.runId);
		const first = await snapshot(sent.runId);
		assert.equal(first.budget.engine, "v2");
		assert.ok(first.events.some((e) => e.type === "tool_result" && /delivered/.test(JSON.stringify(e.payload))), "send_to_bot entregou");

		const runs = await driveBots(userId);
		assert.equal(runs.length, 2, `runs do destino e da volta: ${runs.length}`);
		const [targetRun, wakeRun] = await Promise.all(runs.map((id) => snapshot(id)));
		assert.equal(targetRun!.run.origin, "bot");
		assert.equal(targetRun!.run.botId, bia.botId);
		assert.equal(targetRun!.budget.engine, "v2", "o destino também rodou no v2");
		assert.ok(llm.requests[2]!.toolNames.includes("send_to_bot"), "o destino (v2, bot→bot) tem send_to_bot");
		assert.ok(isBot(llm.requests[2]!, "Bia"));
		assert.equal(wakeRun!.run.botId, ana.botId);
		assert.equal(wakeRun!.budget.engine, "v2");
		assert.match(promptOf(llm.requests[3]!), /R\$ 10,00/, "o remetente recebeu a resposta no turno que o acorda");

		const message = await prisma.botMessage.findFirstOrThrow({ where: { userId } });
		assert.equal(message.fromBotId, ana.botId);
		assert.equal(message.toBotId, bia.botId);
		assert.equal(message.depth, 1);
		assert.ok(["reply_delivered", "closed"].includes(message.status), message.status);
		assert.match(message.replyContent ?? "", /R\$ 10,00/);
	});

	test("pedido sem resposta aparece no turno seguinte do remetente (open_bot_requests) e some depois", async () => {
		const { userId, ana } = await twoBots();
		llm = installFakeLlm([
			{ tools: [{ name: "send_to_bot", args: { bot: "Bia", message: "Mande o PDF", title: "PDF da Semana 2" } }] },
			{ content: "Pedi à Bia." },
			{ content: "Ainda aguardo a Bia." },
		]);
		const { app } = await createApi(userId);
		const first = await sendChat(app, ana, "Peça o PDF para a Bia");
		await processRun(first.runId);
		const second = await sendChat(app, ana, "E o PDF?");
		await processRun(second.runId);
		const system = JSON.stringify(llm.requests[2]!.messages.filter((m) => m.role === "system"));
		assert.match(system, /\[open_bot_requests\]/);
		assert.match(system, /PDF da Semana 2/);
		assert.ok(!JSON.stringify(llm.requests[0]!.messages.filter((m) => m.role === "system")).includes("[open_bot_requests]"), "o primeiro turno não paga o bloco");
	});

	test("cadeia de bots não passa de BOT_MESSAGE_MAX_DEPTH: o salto seguinte falha com erro honesto e o run termina", async () => {
		const { BOT_MESSAGE_MAX_DEPTH } = await import("@workspace/shared");
		const { userId, ana } = await twoBots();
		// Todo run encaminha para o outro bot uma vez e, depois do resultado da tool, responde.
		llm = installFakeLlm(
			[
				(request) =>
					request.messages.at(-1)?.role === "tool"
						? { content: "Respondo com o que tenho." }
						: { tools: [{ name: "send_to_bot", args: { bot: isBot(request, "Bia") ? "Ana" : "Bia", message: "repasse isto", title: "Cadeia" } }] },
			],
			{ repeatLast: true },
		);
		const { app } = await createApi(userId);
		const sent = await sendChat(app, ana, "Comece a cadeia com a Bia");
		await processRun(sent.runId);
		await driveBots(userId, 14);

		const messages = await prisma.botMessage.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
		const depths = messages.map((m) => m.depth);
		assert.ok(Math.max(...depths) <= BOT_MESSAGE_MAX_DEPTH, `profundidade ${JSON.stringify(depths)}`);
		assert.equal(Math.max(...depths), BOT_MESSAGE_MAX_DEPTH, "a cadeia chegou ao limite");
		const refused = await prisma.runEvent.findMany({ where: { type: "tool_result", run: { userId } } });
		assert.ok(refused.some((e) => /Limite de 3 saltos/.test(JSON.stringify(e.payload))), "o salto além do limite voltou ao modelo como erro");
		const runs = await prisma.agentRun.findMany({ where: { userId } });
		assert.ok(runs.every((r) => ["completed", "waiting_user"].includes(r.status)), JSON.stringify(runs.map((r) => r.status)));
	});

	test("um run não passa de BOT_RUN_MAX_SENDS envios; o excedente falha e o run termina", async () => {
		const { BOT_RUN_MAX_SENDS } = await import("@workspace/db");
		const { userId, ana } = await twoBots();
		const calls: ScriptEntry[] = Array.from({ length: BOT_RUN_MAX_SENDS + 1 }, (_, i) => ({ tools: [{ name: "send_to_bot", args: { bot: "Bia", message: `pedido ${i}`, title: `Pedido ${i}` } }] }));
		llm = installFakeLlm([...calls, { content: "Enviei o que deu." }]);
		const { app } = await createApi(userId);
		const sent = await sendChat(app, ana, "Mande vários pedidos para a Bia");
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		assert.equal(await prisma.botMessage.count({ where: { userId, fromRunId: sent.runId } }), BOT_RUN_MAX_SENDS);
		const results = snap.events.filter((e) => e.type === "tool_result").map((e) => JSON.stringify(e.payload));
		assert.equal(results.length, BOT_RUN_MAX_SENDS + 1);
		assert.match(results.at(-1)!, /Limite de 5 mensagens/);
		assert.equal(snap.run.status, "completed");
	});
});
