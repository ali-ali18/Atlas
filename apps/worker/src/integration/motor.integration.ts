/**
 * Integração ponta a ponta do agente, motor atual (v1) e motor novo (v2): Postgres real, modelo roteirizado
 * (sem rede), run criado pela rota real `POST /v1/runs` e processado pelo `processAgentRunJob` real.
 * Como rodar: docs/testes-integracao.md.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import {
	createApi, createFakeConnector, createFixture, createUser, eventTypes, installFakeLlm, pinEngine, postJson, prisma, processRun, sendChat, snapshot,
	type FakeLlm, type ScriptEntry,
} from "./harness.js";

let llm: FakeLlm | undefined;
const script = (entries: ScriptEntry[], options?: { repeatLast?: boolean }) => (llm = installFakeLlm(entries, options));
afterEach(() => { llm?.restore(); llm = undefined; });

const assistantMessages = (messages: Array<{ role: string; content: string }>) => messages.filter((message) => message.role === "assistant");
const APP_TOPICS = ["oauth", "mcp", "webhooks", "vault", "login", "settings", "models", "limits"];

/** Invariantes de qualquer run terminado: eventos em ordem, sem buraco, e fim registrado. */
function assertEventsInOrder(events: Array<{ seq: number; type: string; createdAt: Date }>) {
	assert.ok(events.length > 0, "o run não gravou eventos");
	events.forEach((event, index) => { if (index > 0) assert.ok(event.seq > events[index - 1]!.seq, `seq fora de ordem em ${event.type}`); });
	const times = events.map((event) => event.createdAt.getTime());
	assert.deepEqual(times, [...times].sort((a, b) => a - b), "createdAt dos eventos fora de ordem");
}

describe("1-2. Bom dia", { skip: integrationSkip }, () => {
	test("v1: completed/answered, 1 chamada ao modelo, custo e mensagem gravados", async () => {
		const fake = script([{ content: "Bom dia! Como posso ajudar?", costUsd: 0.0012 }]);
		const fx = await createFixture({ engine: "v1" });
		const { app, queue } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Bom dia");
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		assert.equal(queue.added.length, 1);

		const result = await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(result.status, "completed");
		assert.equal(snap.run.status, "completed");
		assert.equal(snap.run.stopReason, "answered");
		assert.equal(fake.requests.length, 1);
		assert.equal(snap.budget.engine, undefined, "o v1 não grava motor");
		assert.equal(snap.usage.costUsd, 0.0012);
		assert.equal(snap.usage.totalTokens, 120);
		assert.deepEqual(assistantMessages(snap.messages).map((m) => m.content), ["Bom dia! Como posso ajudar?"]);
		assert.equal(snap.messages.filter((m) => m.role === "user").length, 1);
		assertEventsInOrder(snap.events);
		assert.equal(snap.events.at(-1)?.type, "done");
		assert.ok(snap.steps.some((s) => s.type === "model"));
		assert.equal(snap.run.leaseOwner, null, "o lease foi solto");
	});

	test("bot sem escolha e sem variável de ambiente: o run nasce no v2 pelo caminho real (padrão novo)", async () => {
		delete process.env.ATLAS_ENGINE_V2_DEFAULT;
		const fake = script([{ content: "Bom dia! Em que posso ajudar?", costUsd: 0.0012 }]);
		const fx = await createFixture();
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Bom dia");
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		assert.equal(snap.run.status, "completed");
		assert.equal(snap.budget.engine, "v2", "sem escolha explícita o padrão é o motor novo");
		assert.equal(snap.budget.engineProfile, "chat");
		assert.equal(fake.requests.length, 1);
		assert.deepEqual(assistantMessages(snap.messages).map((m) => m.content), ["Bom dia! Em que posso ajudar?"]);
	});

	test("ATLAS_ENGINE_V2_DEFAULT=off (emergência) devolve o bot sem escolha ao v1; v1 explícito segue no v1", async () => {
		process.env.ATLAS_ENGINE_V2_DEFAULT = "off";
		try {
			for (const policy of [undefined, { engine: "v1" as const }]) {
				script([{ content: "Bom dia!" }]);
				const fx = await createFixture(policy ?? {});
				const { app } = await createApi(fx.userId);
				const sent = await sendChat(app, fx, "Bom dia");
				await processRun(sent.runId);
				assert.equal((await snapshot(sent.runId)).budget.engine, undefined, JSON.stringify(policy));
				llm?.restore();
			}
		} finally {
			delete process.env.ATLAS_ENGINE_V2_DEFAULT;
		}
	});

	test("v2 (motor gravado no run): completed/answered, motor v2 em budgetJson, 1 chamada", async () => {
		const fake = script([{ content: "Bom dia! Em que posso ajudar?", costUsd: 0.0012 }]);
		const fx = await createFixture({ engine: "v2" });
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Bom dia");
		await pinEngine(sent.runId, "v2");

		const result = await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(result.status, "completed");
		assert.equal(snap.run.stopReason, "answered");
		assert.equal(snap.budget.engine, "v2");
		assert.equal(snap.budget.engineProfile, "chat");
		assert.equal(fake.requests.length, 1);
		assert.equal(snap.usage.costUsd, 0.0012);
		assert.deepEqual(assistantMessages(snap.messages).map((m) => m.content), ["Bom dia! Em que posso ajudar?"]);
		assertEventsInOrder(snap.events);
		assert.equal(snap.events.at(-1)?.type, "done");
	});

	// Regressão: createAgentRun grava checkpointJson em todo run; a escolha do motor só trata como retomada quando há transcript.
	test("v2 escolhido pelo bot (policyJson.engine = v2) pelo caminho real, sem gravar o motor à mão", async () => {
		script([{ content: "Bom dia!" }]);
		const fx = await createFixture({ engine: "v2" });
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Bom dia");
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		assert.equal(snap.budget.engine, "v2");
	});
});

describe("3-4. v2: pesquisa longa e orçamento", { skip: integrationSkip }, () => {
	test("30 leituras seguidas não cortam no passo 24: termina answered com a entrega", async () => {
		const reads: ScriptEntry[] = Array.from({ length: 30 }, (_, i) => ({ tools: [{ name: "app_info", args: i % 9 === 8 ? {} : { topic: APP_TOPICS[i % 8] } }], costUsd: 0.001 }));
		const fake = script([...reads, { content: "Pesquisa concluída: li 30 fontes e aqui está o resumo final.", costUsd: 0.001 }]);
		const fx = await createFixture({ engine: "v2" });
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Pesquise a fundo sobre os conectores e me entregue um relatório completo");
		await pinEngine(sent.runId, "v2");

		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(snap.run.status, "completed");
		assert.equal(snap.run.stopReason, "answered", `stopDetail=${snap.run.stopDetail} error=${snap.run.error}`);
		assert.equal(fake.requests.length, 31);
		const toolResults = snap.events.filter((e) => e.type === "tool_result");
		assert.equal(toolResults.length, 30);
		assert.ok(toolResults.every((e) => (e.payload as { ok?: boolean }).ok === true), "toda leitura de app_info deveria dar ok");
		assert.equal(assistantMessages(snap.messages).at(-1)?.content, "Pesquisa concluída: li 30 fontes e aqui está o resumo final.");
		assert.equal(Number(snap.usage.costUsd.toFixed(4)), 0.031);
		assertEventsInOrder(snap.events);
	});

	test("v1 com 30 leituras (caracterização): o teto de passos do v1 corta antes do fim", async () => {
		const reads: ScriptEntry[] = Array.from({ length: 30 }, (_, i) => ({ tools: [{ name: "app_info", args: i % 9 === 8 ? {} : { topic: APP_TOPICS[i % 8] } }], costUsd: 0.001 }));
		const fake = script([...reads, { content: "Resumo final.", costUsd: 0.001 }], { repeatLast: true });
		const fx = await createFixture({ engine: "v1" });
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Pesquise a fundo sobre os conectores e me entregue um relatório completo");
		const outcome = await processRun(sent.runId).then((r) => r, (error: unknown) => error);
		const snap = await snapshot(sent.runId);
		// Registra o comportamento do v1 (referência para a migração): não chega às 30 leituras com resposta "answered".
		assert.ok(fake.requests.length < 31, `o v1 fez ${fake.requests.length} chamadas`);
		assert.notEqual(snap.run.stopReason, "answered");
		assert.ok(snap.run.stopReason, "o run terminou com um motivo");
	});

	test("estouro de orçamento (custo alto): entrega final sem tools, budget_cost e resposta não vazia", async () => {
		const fake = script([
			{ tools: [{ name: "app_info", args: { topic: "oauth" } }], costUsd: 0.3 },
			(request) => {
				assert.equal(request.body.tool_choice, "none", "a entrega final proíbe tools (tool_choice none)");
				return { content: "Orçamento esgotado. Resultado parcial: o que consegui ler até aqui.", costUsd: 0.001 };
			},
		]);
		const fx = await createFixture({ engine: "v2" });
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Pesquise a fundo sobre os conectores");
		await pinEngine(sent.runId, "v2");

		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(fake.requests.length, 2);
		assert.equal(snap.run.stopReason, "budget_cost");
		assert.equal(snap.run.stopDetail, "delivered");
		assert.ok(snap.run.resultText && snap.run.resultText.trim().length > 0);
		const last = assistantMessages(snap.messages).at(-1);
		assert.match(last?.content ?? "", /Orçamento esgotado/);
		assert.ok(snap.usage.costUsd >= 0.3);
		assertEventsInOrder(snap.events);
	});
});

describe("5. confirmação de escrita (conector com cartão)", { skip: integrationSkip }, () => {
	for (const engine of ["v1", "v2"] as const) {
		test(`${engine}: a escrita no conector para no cartão confirm, awaiting_confirmation e nada é executado`, async () => {
			const fake = script([
				{ tools: [{ name: "mcp__erp__create_order", args: { customer: "Exemplo", total: 10 } }] },
				// O 1º uso carrega a tool; o modelo chama de novo e o cartão sai.
				{ tools: [{ name: "mcp__erp__create_order", args: { customer: "Exemplo", total: 10 } }] },
				{ content: "Preparei o pedido; confirme no cartão." },
			], { repeatLast: true });
			const fx = await createFixture({ engine });
			await createFakeConnector(fx.userId);
			const { app } = await createApi(fx.userId);
			const sent = await sendChat(app, fx, "Crie um pedido de R$ 10 para o cliente Exemplo no ERP");
			if (engine === "v2") await pinEngine(sent.runId, "v2");

			await processRun(sent.runId);
			const snap = await snapshot(sent.runId);

			const cards = snap.messages.map((m) => { try { return JSON.parse(m.content) as { kind?: string; status?: string }; } catch { return null; } }).filter((card) => card?.kind === "confirm");
			assert.equal(cards.length, 1, "um cartão confirm persistido");
			assert.equal(cards[0]?.status ?? "pending", "pending");
			assert.equal(snap.run.stopReason, "awaiting_confirmation");
			assert.equal(snap.run.stopDetail, "confirm");
			assertEventsInOrder(snap.events);
		});
	}
});

describe("6. cancelamento no meio do run", { skip: integrationSkip }, () => {
	for (const engine of ["v1", "v2"] as const) {
		test(`${engine}: cancelado no meio termina cancelled, sem resposta duplicada`, async () => {
			const fx = await createFixture({ engine });
			const { app } = await createApi(fx.userId);
			let wake: ((kind: string) => void) | undefined;
			script([
				{ tools: [{ name: "app_info", args: { topic: "oauth" } }] },
				{
					content: "Esta resposta não deveria sobreviver ao cancelamento.",
					before: async () => {
						const res = await postJson(app, `/v1/runs/${runIdRef.id}/cancel`, {});
						assert.equal(res.status, 200, JSON.stringify(res.json));
						wake?.("cancel");
						await new Promise((resolve) => setTimeout(resolve, 150));
					},
				},
			], { repeatLast: true });
			const runIdRef = { id: "" };
			const sent = await sendChat(app, fx, "Pesquise a fundo sobre os conectores e me entregue um relatório");
			runIdRef.id = sent.runId;
			if (engine === "v2") await pinEngine(sent.runId, "v2");

			const result = await processRun(sent.runId, { subscribeRunSignals: (_runId, onSignal) => { wake = onSignal; return () => { wake = undefined; }; } });
			const snap = await snapshot(sent.runId);

			assert.equal(result.status, "cancelled");
			assert.equal(snap.run.status, "cancelled");
			assert.equal(snap.run.stopReason, "cancelled");
			assert.ok(assistantMessages(snap.messages).length <= 1, `respostas do assistente: ${assistantMessages(snap.messages).length}`);
			assert.ok(!assistantMessages(snap.messages).some((m) => /não deveria sobreviver/.test(m.content)), "a resposta do passo cancelado não vira mensagem");
			assert.equal(snap.run.leaseOwner, null);
			assertEventsInOrder(snap.events);
		});
	}
});

describe("7. retomada do v2 com checkpoint", { skip: integrationSkip }, () => {
	test("worker reiniciado no meio: o run reprocessado continua no v2, com o histórico, e termina answered", async () => {
		const fx = await createFixture({ engine: "v2" });
		const { app } = await createApi(fx.userId);
		const shutdown = new AbortController();
		const fake = script([
			{ tools: [{ name: "app_info", args: { topic: "oauth" } }], costUsd: 0.002 },
			{ tools: [{ name: "app_info", args: { topic: "mcp" } }], costUsd: 0.002, // O abort chega com o fetch pendente (como um SIGTERM de verdade), nunca dentro da própria chamada síncrona.
				before: async () => { setTimeout(() => shutdown.abort(), 10); await new Promise((resolve) => setTimeout(resolve, 100)); } },
			{ content: "Retomei de onde parei e concluí.", costUsd: 0.002 },
		]);
		const sent = await sendChat(app, fx, "Pesquise a fundo sobre os conectores e me entregue um relatório");
		await pinEngine(sent.runId, "v2");

		const first = await processRun(sent.runId, { shutdownSignal: shutdown.signal }).then((r) => ({ ok: true as const, r }), (error: unknown) => ({ ok: false as const, error }));
		const mid = await snapshot(sent.runId);
		assert.ok(!first.ok || first.r.status !== "completed", "a 1a passada não terminou o run");
		assert.notEqual(mid.run.status, "completed");
		assert.equal(mid.budget.engine, "v2");
		assert.ok(mid.run.checkpointJson, "o checkpoint ficou gravado");

		const second = await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(second.status, "completed");
		assert.equal(snap.run.stopReason, "answered");
		assert.equal(snap.budget.engine, "v2", "continua no v2");
		const lastRequest = fake.requests.at(-1)!;
		const flat = JSON.stringify(lastRequest.messages);
		assert.match(flat, /Pesquise a fundo/, "o histórico do pedido voltou ao modelo");
		assert.ok(lastRequest.messages.some((m) => m.role === "tool"), "o resultado da tool anterior voltou ao modelo");
		assert.equal(assistantMessages(snap.messages).at(-1)?.content, "Retomei de onde parei e concluí.");
		assert.equal(assistantMessages(snap.messages).length, 1, "uma resposta só");
		assertEventsInOrder(snap.events);
	});
});

describe("8. escopo entre usuários", { skip: integrationSkip }, () => {
	test("B não dispara run no bot de A, não vê o run nem os eventos, não cancela", async () => {
		script([{ content: "oi" }]);
		const a = await createFixture({ engine: "v2" });
		const bUser = await createUser("intruso");
		const apiA = await createApi(a.userId);
		const apiB = await createApi(bUser);
		const sent = await sendChat(apiA.app, a, "Bom dia");
		assert.equal(sent.status, 202);
		const runsBefore = await prisma.agentRun.count({ where: { conversationId: a.conversationId } });

		const attempt = await sendChat(apiB.app, a, "Bom dia, sou eu");
		assert.equal(attempt.status, 404);
		assert.equal(await prisma.agentRun.count({ where: { conversationId: a.conversationId } }), runsBefore, "nenhum run novo no bot de A");
		assert.equal(await prisma.agentRun.count({ where: { userId: bUser } }), 0);
		assert.equal(apiB.queue.added.length, 0);

		for (const suffix of ["", "/events", "/inputs", "/inspect"]) {
			const res = await apiB.app.request(`/v1/runs/${sent.runId}${suffix}`);
			assert.equal(res.status, 404, `GET ${suffix || "/"}`);
		}
		for (const suffix of ["/cancel", "/pause", "/resume", "/inputs"]) {
			const res = await postJson(apiB.app, `/v1/runs/${sent.runId}${suffix}`, { content: "oi" });
			assert.equal(res.status, 404, `POST ${suffix}`);
		}
		const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: sent.runId } });
		assert.equal(after.cancelRequested, false, "o cancelamento de B não surtiu efeito");
		assert.equal((await apiA.app.request(`/v1/runs/${sent.runId}`)).status, 200, "A continua vendo o próprio run");
	});
});
