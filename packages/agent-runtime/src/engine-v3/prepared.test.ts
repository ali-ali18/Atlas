import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { BotMailboxRecord } from "@workspace/db";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint, ComputerUseEvent, EffectiveAutonomy } from "@workspace/shared";
import type { EmailRunContext } from "../email/tools.js";
import type { ComputerUseParams } from "../run-types.js";
import { COMPUTER_USE_TOOLS } from "../tools/catalog.js";
import { PREPARE_FOR_OWNER_TOOL_NAME } from "../tools/prepare-for-owner.js";
import { toolCallKey } from "./approval.js";
import { runEngineV3 } from "./loop.js";
import { PREPARED_DRAFT_RESULT, PREPARE_ONE_PER_RUN } from "./prepared.js";

/**
 * Banco em memória do cartão genérico: a intenção pendente (uma por conversa) e os cartões com o desfecho. O dono
 * "clica" com `approve(confirmId)`; `takeToolCallApproval` segue a regra real: só o run de continuação daquele
 * cartão, uma vez só.
 */
const db = vi.hoisted(() => ({
	intents: [] as Array<{ conversationId: string; payload: Record<string, unknown>; ttlMs?: number }>,
	cards: [] as Array<{ confirmId: string; callKey?: string; title?: string; description?: string; status: "pending" | "approved" | "rejected"; used?: boolean }>,
}));
vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	persistConversationCardFromEvent: vi.fn(async (_conversationId: string, event: { type: string; confirmId?: string; callKey?: string; title?: string; description?: string }) => {
		if (event.type === "confirm" && event.confirmId) db.cards.push({ confirmId: event.confirmId, callKey: event.callKey, title: event.title, description: event.description, status: "pending" });
	}),
	saveSkillPendingIntent: vi.fn(async (input: { conversationId: string; payload: Record<string, unknown>; ttlMs?: number }) => {
		db.intents = db.intents.filter((intent) => intent.conversationId !== input.conversationId);
		db.intents.push(input);
	}),
	takeToolCallApproval: vi.fn(async (_userId: string, _conversationId: string, callKey: string, askingRunId: string | undefined) => {
		const card = [...db.cards].reverse().find((item) => item.callKey === callKey && item.confirmId.endsWith(`-${askingRunId}`));
		if (!askingRunId || !card || card.status !== "approved" || card.used) return null;
		card.used = true;
		return "approved";
	}),
}));

const approve = (confirmId: string) => {
	const card = db.cards.find((item) => item.confirmId === confirmId);
	if (card) card.status = "approved";
};

const BALANCED: EffectiveAutonomy = { level: "balanced", exceptions: [] };
const MAILBOX = { id: "mbx_1", botId: "bot-a", userId: "user-a", provider: "openmail", address: "bot@openmail.sh", providerInboxId: "inb_1", secretsEnc: null, webhookSecretHash: "h", allowedSenders: [], dailySendLimit: 20, enabled: true, createdAt: new Date() } as unknown as BotMailboxRecord;

/** Caixa do bot com o serviço de envio dublado: `delivered` conta os envios reais. */
function emailContext() {
	const delivered: Array<{ to: string; subject: string }> = [];
	const service = {
		prepareSend: vi.fn(async (req: { to?: string; subject?: string; body: string }) => ({ to: (req.to ?? "").toLowerCase(), subject: req.subject ?? "", body: req.body, newRecipient: true })),
		deliver: vi.fn(async (input: { prepared: { to: string; subject: string } }) => {
			delivered.push(input.prepared);
			return { threadId: "thr_9", messageId: "m9", to: input.prepared.to, subject: input.prepared.subject };
		}),
		remainingToday: vi.fn(async () => 5),
		readThread: vi.fn(async () => ({ threadId: "t", subject: "", messages: [] })),
		accountStatus: vi.fn(async () => ({ provider: "openmail" as const, configured: true, source: "account" as const, vaultReady: true })),
	};
	const email: EmailRunContext = { mailbox: MAILBOX, botName: "Atendente", service: service as never, sendPolicy: () => BALANCED };
	return { email, delivered };
}

const call = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

type Script = Array<CompleteChatWithToolsResult | ((params: CompleteChatWithToolsParams) => CompleteChatWithToolsResult)>;

async function runV3(script: Script, extra: Partial<ComputerUseParams> = {}) {
	const events: ComputerUseEvent[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const requests: CompleteChatWithToolsParams[] = [];
	const queue = [...script];
	let error: unknown;
	try {
		await runEngineV3({
			manager: {} as SandboxManager,
			getSessionId: async () => "s",
			sandboxEnabled: false,
			model: "m",
			apiKey: "k",
			runId: "run-routine",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "routine",
			humanTurn: false,
			messages: [{ role: "user", content: "Rotina: mande o resumo de vendas por e-mail para ana@cliente.com" }],
			onEvent: (event) => { events.push(event); },
			onCheckpoint: async (snapshot) => { checkpoints.push(snapshot as AgentRunCheckpoint); },
			streamChat: async (params) => {
				requests.push(params);
				const next = queue.shift();
				if (!next) throw new Error("roteiro acabou");
				return typeof next === "function" ? next(params) : next;
			},
			...extra,
		});
	} catch (caught) {
		error = caught;
	}
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	const confirms = events.filter((event): event is Extract<ComputerUseEvent, { type: "confirm" }> => event.type === "confirm");
	return { error, events, results, confirms, checkpoints, requests };
}

const offered = (params: CompleteChatWithToolsParams) => (params.tools ?? []).map((tool) => tool.function.name);
const SEND = { to: "ana@cliente.com", subject: "Vendas de outubro", body: "Total: R$ 10 mil." };

beforeEach(() => {
	db.intents = [];
	db.cards = [];
});

describe("prepare_for_owner: só sem pessoa", () => {
	it("rotina, webhook, proativo, e-mail recebido e outro bot recebem a tool no núcleo; chat com pessoa, não", async () => {
		const { email } = emailContext();
		for (const origin of ["routine", "webhook", "proactive", "email", "bot"] as const) {
			const { requests } = await runV3([say("ok")], { origin, email });
			expect(offered(requests[0]!), origin).toContain(PREPARE_FOR_OWNER_TOOL_NAME);
			expect(offered(requests[0]!), origin).not.toContain("email_send");
		}
		const chat = await runV3([say("ok")], { origin: "chat", humanTurn: true, email });
		expect(offered(chat.requests[0]!)).not.toContain(PREPARE_FOR_OWNER_TOOL_NAME);
		expect(chat.requests[0]!.messages.map((message) => String(message.content ?? "")).join(" ")).not.toContain(PREPARE_FOR_OWNER_TOOL_NAME);
	});

	it("subagente e run sem conversa não recebem (não há onde pôr o cartão)", async () => {
		const { requests } = await runV3([say("ok")], { conversationId: undefined });
		expect(offered(requests[0]!)).not.toContain(PREPARE_FOR_OWNER_TOOL_NAME);
	});

	it("v1/v2 não têm a tool no catálogo", () => {
		expect(COMPUTER_USE_TOOLS.map((tool) => tool.function.name)).not.toContain(PREPARE_FOR_OWNER_TOOL_NAME);
	});
});

describe("prepare_for_owner: rascunho, validação e uma execução só", () => {
	it("replay: rotina que tenta mandar e-mail vira rascunho para o dono, com zero envio", async () => {
		const { email, delivered } = emailContext();
		const { results, confirms, requests } = await runV3(
			[
				call("c1", "email_send", SEND),
				call("c2", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "Resumo de vendas de outubro para a Ana." }),
				say("Deixei o e-mail do resumo pronto para você aprovar."),
			],
			{ email },
		);
		expect(delivered).toHaveLength(0);
		// A tentativa direta não executa: a política diz por quê (sem pessoa, envio nunca é feito sozinho).
		expect(results[0]).toMatchObject({ name: "email_send", ok: false });
		expect(results[0]!.summary).toMatch(/no human present/);
		// O rascunho: cartão genérico de aprovação com a ação e os args, intenção `tool-call` marcada `prepared`.
		expect(results[1]).toMatchObject({ name: PREPARE_FOR_OWNER_TOOL_NAME, ok: true });
		expect(results[1]!.summary).toBe(PREPARED_DRAFT_RESULT("Enviar esta mensagem"));
		expect(confirms).toHaveLength(1);
		expect(confirms[0]).toMatchObject({ title: "Enviar esta mensagem?", confirmLabel: "Permitir", cancelLabel: "Agora não", callKey: toolCallKey("email_send", SEND) });
		expect(confirms[0]!.confirmId).toMatch(/^confirm-tool[0-9a-f]{8}-run-routine$/);
		expect(confirms[0]!.description).toContain("Resumo de vendas de outubro para a Ana.");
		expect(confirms[0]!.description).toContain("to: ana@cliente.com");
		expect(db.intents[0]!.payload).toMatchObject({ action: "tool-call", toolCall: { tool: "email_send", prepared: true, callKey: toolCallKey("email_send", SEND) } });
		// O run sem pessoa não estaciona: segue e termina com a resposta.
		expect(requests).toHaveLength(3);
	});

	it("args inválidos falham com a lista dos campos aceitos; tool alvo inválida lista as aceitas; nada é criado", async () => {
		const { email } = emailContext();
		const { results, confirms } = await runV3(
			[
				call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: { ...SEND, cc: "x@y.com" }, note: "n" }),
				call("c2", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: { to: "ana@cliente.com" }, note: "n" }),
				call("c3", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "apagar_tudo", args: {}, note: "n" }),
				call("c4", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "skill_read", args: {}, note: "n" }),
				say("não deu"),
			],
			{ email },
		);
		expect(results.map((result) => result.ok)).toEqual([false, false, false, false]);
		expect(results[0]!.summary).toMatch(/unknown field cc \(accepted: to, subject, body, body_html\)/);
		expect(results[1]!.summary).toMatch(/missing required subject/);
		expect(results[2]!.summary).toMatch(/Accepted: email_reply, email_send/);
		expect(results[3]!.summary).toMatch(/available in this run; call it directly/);
		expect(confirms).toHaveLength(0);
		expect(db.intents).toHaveLength(0);
	});

	it("um rascunho por run (a conversa guarda um cartão pendente por vez)", async () => {
		const { email } = emailContext();
		const { results } = await runV3(
			[
				call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "n" }),
				call("c2", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: { ...SEND, to: "bia@cliente.com" }, note: "n" }),
				say("ok"),
			],
			{ email },
		);
		expect(results[1]).toMatchObject({ ok: false, summary: PREPARE_ONE_PER_RUN });
		expect(db.cards).toHaveLength(1);
	});

	it("sem aprovação nunca executa: a continuação sem clique é recusada; aprovado, envia UMA vez", async () => {
		const { email, delivered } = emailContext();
		const routine = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "n" }), say("rascunho pronto")], { email });
		const confirmId = routine.confirms[0]!.confirmId;
		// Run de continuação do cartão (origem chat, sem turno humano: é o clique), semeado com o run que preparou.
		const continuation = (script: Script) =>
			runV3(script, { runId: "run-cont", origin: "chat", humanTurn: false, email, restoredCheckpoint: { version: 2, messages: [{ role: "user", content: "[The owner APPROVED your draft]" }], transcriptSeed: { fromRunId: "run-routine", resultContent: "x", shortContent: "x" } } as unknown as AgentRunCheckpoint, messages: [{ role: "user", content: "[The owner APPROVED your draft]" }] });

		const early = await continuation([call("c1", "email_send", SEND), say("ainda não")]);
		expect(early.results[0]).toMatchObject({ name: "email_send", ok: false });
		expect(delivered).toHaveLength(0);

		approve(confirmId);
		// Args diferentes do aprovado: não valem a aprovação.
		const other = await continuation([call("c1", "email_send", { ...SEND, to: "outra@cliente.com" }), say("não")]);
		expect(other.results[0]!.ok).toBe(false);
		expect(delivered).toHaveLength(0);

		const approved = await continuation([call("c1", "email_send", SEND), call("c2", "email_send", SEND), say("enviado")]);
		expect(approved.results[0], approved.results[0]?.summary).toMatchObject({ name: "email_send", ok: true });
		expect(approved.results[0]!.summary).toContain('"sent":true');
		// O próprio cartão do e-mail não aparece de novo: o clique do rascunho já foi a aprovação.
		expect(approved.confirms).toHaveLength(0);
		// A mesma chamada de novo: a aprovação já foi usada.
		expect(approved.results[1]).toMatchObject({ name: "email_send", ok: false });
		expect(delivered.map(({ to, subject }) => ({ to, subject }))).toEqual([{ to: "ana@cliente.com", subject: "Vendas de outubro" }]);
	});
});

describe("prepare_for_owner: continuação que herdou turno humano de uma fala antiga", () => {
	it("aprovado: uma execução com os args idênticos e sem segundo cartão; args diferentes ou repetição não usam a aprovação", async () => {
		const { email, delivered } = emailContext();
		const routine = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "n" }), say("rascunho pronto")], { email });
		approve(routine.confirms[0]!.confirmId);
		const continuation = (script: Script) =>
			runV3(script, { runId: "run-cont", origin: "chat", humanTurn: true, email, restoredCheckpoint: { version: 2, messages: [{ role: "user", content: "[The owner APPROVED your draft]" }], transcriptSeed: { fromRunId: "run-routine", resultContent: "x", shortContent: "x" } } as unknown as AgentRunCheckpoint, messages: [{ role: "user", content: "[The owner APPROVED your draft]" }] });

		// Args diferentes do aprovado: caminho normal com pessoa (o cartão próprio do e-mail), nada enviado.
		const other = await continuation([call("c1", "email_send", { ...SEND, to: "outra@cliente.com" }), say("aguardando")]);
		expect(other.results[0]!.summary).toMatch(/Card de confirmação enviado/);
		expect(delivered).toHaveLength(0);

		const exact = await continuation([call("c1", "email_send", SEND), say("enviado")]);
		expect(exact.results[0]!.summary, exact.results[0]!.summary).toContain('"sent":true');
		expect(exact.confirms).toHaveLength(0);

		// A mesma chamada de novo: a aprovação já foi usada, volta o cartão do e-mail e nada sai.
		const again = await continuation([call("c1", "email_send", SEND), say("aguardando")]);
		expect(again.results[0]!.summary).toMatch(/Card de confirmação enviado/);
		expect(delivered.map(({ to }) => to)).toEqual(["ana@cliente.com"]);
	});
});
