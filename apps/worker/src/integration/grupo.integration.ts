/**
 * Integração dos grupos de bots (Cookie principal + 2 membros): despacho real do db, runs processados pelo
 * `processAgentRunJob` real, modelo roteirizado, Postgres real.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import {
	createFakeConnector, createFixture, createUser, driveGroup, installFakeLlm, promptOf, prisma, resetOpenGroupWork,
	type FakeLlm, type LlmRequest, type ScriptedStep,
} from "./harness.js";

let llm: FakeLlm | undefined;
// O despacho varre o banco inteiro: trabalho de grupo aberto de execuções anteriores não pode entrar neste teste.
before(resetOpenGroupWork);
afterEach(() => { llm?.restore(); llm = undefined; });

const MIN_DELIVERY = " Fontes: levantamento interno de 2026, com preço e posicionamento de cada concorrente, conferidos um a um.";

async function createTeam(options: { radarAutonomy?: unknown } = {}) {
	const userId = await createUser("grupo");
	// Coordenação e cobrança do grupo são do motor anterior (v1 explícito): o padrão novo (v2) em grupo é coberto em `origens.integration.ts`.
	const cookie = await createFixture({ userId, name: "Cookie", isPrimary: true, engine: "v1" });
	const radar = await createFixture({ userId, name: "Radar", engine: "v1" });
	const inspetor = await createFixture({ userId, name: "Inspetor", engine: "v1" });
	if (options.radarAutonomy) await prisma.bot.update({ where: { id: radar.botId }, data: { autonomyJson: options.radarAutonomy as never } });
	const { createGroup, postGroupUserMessage } = await import("@workspace/db");
	const group = await createGroup(userId, { name: "Time", memberIds: [cookie.botId, radar.botId, inspetor.botId] });
	return { userId, cookie, radar, inspetor, group, post: (content: string) => postGroupUserMessage({ userId, groupId: group.id, content }) };
}

/** Coordenação ligada (Jev simulado): "tarefa de vários membros" decide o coordenador; a verificação sempre aprova. */
const jevCoordinating = {
	enabled: async () => true,
	ask: async ({ questions }: { questions: Record<string, unknown> }): Promise<Record<string, number>> => ("fulfilled" in questions ? { fulfilled: 1 } : { multi_task: 1, group_wide: 0 }),
};

function teamScript(options: { inspetorStubborn: boolean }): (request: LlmRequest) => ScriptedStep {
	return (request) => {
		const prompt = promptOf(request);
		if (/você é o coordenador/.test(prompt)) return { content: "@Radar levante os concorrentes e entregue a lista\n@Inspetor inspecione o plano e entregue o laudo" };
		if (/subtarefa a você: .*concorrentes/.test(prompt)) return { content: `Concorrentes: Alfa, Beta e Gama.${MIN_DELIVERY}` };
		if (/subtarefa a você: .*inspecione/.test(prompt)) {
			const nudged = /did not deliver it/.test(prompt);
			if (nudged && !options.inspetorStubborn) return { content: `Laudo: plano consistente, com duas ressalvas de prazo (assumi o escopo do pedido original).${MIN_DELIVERY}` };
			return { content: "Me envie o plano completo que eu faço a inspeção." };
		}
		if (/Escreva agora o resumo final/.test(prompt)) return { content: "Resumo: o Radar entregou a lista de concorrentes. O Inspetor não entregou o laudo. Próximo passo: refazer a inspeção com o plano." };
		return { content: "ok" };
	};
}

describe("9a. grupo com coordenação: cobrança única e resumo", { skip: integrationSkip }, () => {
	test("membro que pede o plano recebe 1 cobrança, entrega, e o resumo sai sem 'aguardar'", async () => {
		llm = installFakeLlm([teamScript({ inspetorStubborn: false })], { repeatLast: true });
		const team = await createTeam();
		const posted = await team.post("Quero um levantamento de concorrentes e a inspeção do plano, por favor");

		await driveGroup({ jev: jevCoordinating });

		const replies = await prisma.groupReply.findMany({ where: { turnId: posted.turnId }, orderBy: { createdAt: "asc" } });
		const summary = [...replies].reverse().find((r) => r.role === "summary");
		const inspetorReplies = replies.filter((r) => r.botId === team.inspetor.botId);
		assert.equal(replies.filter((r) => r.reason === "nudge").length, 1, "exatamente 1 cobrança no turno");
		assert.equal(inspetorReplies.filter((r) => r.reason === "nudge").length, 1);
		assert.equal(inspetorReplies[0]?.error, "undelivered:waiting", "a 1a resposta foi marcada como não entregue");
		assert.ok(summary, "o resumo do coordenador foi enfileirado");
		assert.equal(summary!.status, "done");
		assert.equal(summary!.botId, team.cookie.botId);
		assert.equal(replies.filter((r) => r.role === "summary").length, 1, "um resumo só");
		const turn = await prisma.groupTurn.findUniqueOrThrow({ where: { id: posted.turnId } });
		assert.equal(turn.status, "done");

		const summaryPrompt = llm.requests.map(promptOf).find((p) => /Escreva agora o resumo final/.test(p)) ?? "";
		assert.doesNotMatch(summaryPrompt, /Not delivered:/, "todos entregaram: nada de pendência no resumo");
		assert.match(summaryPrompt, /never say the next step is to wait/);
		const conv = await prisma.conversationMessage.findMany({ where: { conversationId: team.group.conversationId! }, orderBy: { createdAt: "asc" } });
		const lastAssistant = [...conv].reverse().find((m) => m.role === "assistant");
		assert.ok(lastAssistant, "o resumo foi publicado no grupo");
		assert.doesNotMatch(lastAssistant!.content, /aguard/i);
	});

	test("membro teimoso (pede o plano de novo): continua 1 cobrança só e o resumo marca a falta sem esperar", async () => {
		llm = installFakeLlm([teamScript({ inspetorStubborn: true })], { repeatLast: true });
		const team = await createTeam();
		const posted = await team.post("Quero um levantamento de concorrentes e a inspeção do plano, por favor");

		await driveGroup({ jev: jevCoordinating });

		const replies = await prisma.groupReply.findMany({ where: { turnId: posted.turnId }, orderBy: { createdAt: "asc" } });
		assert.equal(replies.filter((r) => r.reason === "nudge").length, 1, "nunca mais de 1 cobrança por membro");
		const inspetor = replies.filter((r) => r.botId === team.inspetor.botId);
		assert.equal(inspetor.length, 2, "resposta inicial + a cobrança");
		assert.ok(inspetor.every((r) => r.error === "undelivered:waiting"));
		const summary = replies.find((r) => r.role === "summary");
		assert.ok(summary && summary.status === "done", "o resumo saiu mesmo com o membro sem entregar");
		const summaryPrompt = llm.requests.map(promptOf).find((p) => /Escreva agora o resumo final/.test(p)) ?? "";
		assert.match(summaryPrompt, /Inspetor did not deliver: replied that it is waiting for something instead of delivering/);
		assert.match(summaryPrompt, /never say the next step is to wait/);
		const turn = await prisma.groupTurn.findUniqueOrThrow({ where: { id: posted.turnId } });
		assert.equal(turn.status, "done");
	});
});

describe("9b. grupo: aceite automático do principal", { skip: integrationSkip }, () => {
	const pendingCards = (conversationId: string) => prisma.conversationMessage.findMany({ where: { conversationId, role: "confirm" } });
	const autoNotes = async (conversationId: string) => {
		const rows = await prisma.conversationMessage.findMany({ where: { conversationId, role: "bot-link" }, orderBy: { createdAt: "asc" } });
		return rows.map((row) => JSON.parse(row.content) as { kind?: string; decision?: string; botName?: string; deciderName?: string; status?: string }).filter((card) => card.kind === "auto-decision");
	};

	test("membro para num cartão de leitura e o principal aceita sozinho (uma nota, sem repetir)", async () => {
		// "Sempre perguntar" nesta leitura do conector faz o Radar parar num cartão que é só leitura (marcada pelo dono).
		const team = await createTeam({ radarAutonomy: { exceptions: [{ tool: "mcp__erp__find_customer", mode: "always_ask" }] } });
		await createFakeConnector(team.userId, { markRead: ["find_customer"] });
		llm = installFakeLlm([{ tools: [{ name: "mcp__erp__find_customer", args: { name: "Exemplo" } }] }], { repeatLast: true });
		await team.post("@Radar busque o cliente Exemplo no ERP");

		await driveGroup({ maxPasses: 6 });

		const conversationId = team.group.conversationId!;
		const cards = await pendingCards(conversationId);
		assert.equal(cards.length, 1, "o Radar parou num cartão de confirmação");
		const notes = await autoNotes(conversationId);
		assert.equal(notes.length, 1, "o principal aceitou: uma nota de decisão");
		assert.equal(notes[0]!.decision, "approved");
		assert.equal(notes[0]!.botName, "Radar");
		assert.equal(notes[0]!.deciderName, "Cookie");

		const { autoDecideGroupPending } = await import("@workspace/db");
		const again = await autoDecideGroupPending();
		assert.equal(again.approved, 0, "varrer de novo não repete o aceite");
		assert.equal((await autoNotes(conversationId)).length, 1);
		const run = await prisma.agentRun.findFirstOrThrow({ where: { conversationId, botId: team.radar.botId }, orderBy: { createdAt: "desc" } });
		assert.equal(run.stopReason, "awaiting_confirmation");
	});

	test("escrita no conector (criar pedido) NÃO é aceita sozinha: o cartão espera o usuário", async () => {
		const team = await createTeam();
		await createFakeConnector(team.userId);
		llm = installFakeLlm([{ tools: [{ name: "mcp__erp__create_order", args: { customer: "Exemplo", total: 10 } }] }], { repeatLast: true });
		await team.post("@Radar crie um pedido de R$ 10 para o cliente Exemplo no ERP");

		await driveGroup({ maxPasses: 6 });

		const conversationId = team.group.conversationId!;
		assert.equal((await pendingCards(conversationId)).length, 1);
		assert.equal((await autoNotes(conversationId)).length, 0, "nenhum aceite automático para escrita");
	});
});
