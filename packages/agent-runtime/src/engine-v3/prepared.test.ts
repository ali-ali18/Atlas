import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { BotMailboxRecord } from "@workspace/db";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint, ComputerUseEvent, EffectiveAutonomy } from "@workspace/shared";
import type { EmailRunContext } from "../email/tools.js";
import type { ComputerUseParams } from "../run-types.js";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { COMPUTER_USE_TOOLS } from "../tools/catalog.js";
import { PREPARE_FOR_OWNER_TOOL_NAME } from "../tools/prepare-for-owner.js";
import { toolCallKey } from "./approval.js";
import { runEngineV3 } from "./loop.js";
import { PREPARED_DRAFT_RESULT, PREPARE_ONE_PER_RUN, PREPARE_OWNER_BUSY } from "./prepared.js";

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
	saveSkillPendingIntentIfFree: vi.fn(async (input: { conversationId: string; payload: Record<string, unknown>; ttlMs?: number }) => {
		if (db.intents.some((intent) => intent.conversationId === input.conversationId)) return false;
		db.intents.push(input);
		return true;
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
		expect(confirms[0]!.ownerCard).toBe("draft");
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

	it("pedido do dono já esperando na conversa (plano, PR, segredos, outro cartão): não sobrescreve, rascunho não sai", async () => {
		const { email } = emailContext();
		db.intents.push({ conversationId: "conv-1", payload: { kind: "confirm", action: "plan", confirmId: "confirm-plan-x" } });
		const { results, confirms } = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "n" }), say("um pedido seu já está aguardando")], { email });
		expect(results[0]).toMatchObject({ ok: false, summary: PREPARE_OWNER_BUSY });
		expect(confirms).toHaveLength(0);
		expect(db.intents).toEqual([expect.objectContaining({ payload: expect.objectContaining({ action: "plan" }) })]);
	});

	it("um rascunho por run vale também depois de uma retomada (o contador vem do checkpoint)", async () => {
		const { email } = emailContext();
		const first = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: SEND, note: "n" }), say("ok")], { email });
		const saved = first.checkpoints.at(-1)!;
		expect((saved.engineV3 as Record<string, unknown>).draftsPrepared).toBe(1);
		db.intents = [];
		const resumed = await runV3([call("c2", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "email_send", args: { ...SEND, to: "bia@cliente.com" }, note: "n" }), say("ok")], { email, restoredCheckpoint: saved });
		expect(resumed.results[0]).toMatchObject({ ok: false, summary: PREPARE_ONE_PER_RUN });
		expect(resumed.confirms).toHaveLength(0);
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

describe("prepare_for_owner: escrita de conector como alvo (PR8e)", () => {
	const trello = {
		id: "conn-trello",
		slug: "trello",
		name: "Trello",
		disabledTools: [],
		tools: [
			{ name: "get_card", description: "Reads a card", inputSchema: { type: "object", properties: { card_id: { type: "string" } }, required: ["card_id"] }, annotations: { readOnlyHint: true } },
			{
				name: "update_card",
				description: "Moves or edits a card",
				inputSchema: { type: "object", properties: { card_id: { type: "string" }, list: { type: "string" }, comment: { type: "string" } }, required: ["card_id"] },
				annotations: { readOnlyHint: false, destructiveHint: false },
			},
		],
	};
	const readOnlyConnector = { id: "conn-docs", slug: "docs", name: "Docs", disabledTools: [], tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }] };
	const UPDATE = "mcp__trello__update_card";
	const ARGS = { card_id: "c-42", list: "Feito" };
	const connectors = (list: Array<typeof trello | typeof readOnlyConnector> = [trello, readOnlyConnector]) => {
		const mcpCall = vi.fn(async () => ({ ok: true, text: "ok", truncated: false }));
		const mcp = { toolset: buildMcpToolset(list, { autonomy: BALANCED }), call: mcpCall } as unknown as McpRuntime;
		return { mcp, mcpCall };
	};
	const routineText = { messages: [{ role: "user" as const, content: "Rotina: confira o quadro e mova o cartão c-42 para Feito" }] };

	it("replay T5 do PR9: rotina só-leitura tenta escrever no Trello → rascunho → zero escrita sem clique", async () => {
		const { mcp, mcpCall } = connectors();
		const routine = await runV3(
			[
				call("c1", UPDATE, ARGS),
				(params) => {
					// A recusa diz o caminho: rascunho para o dono, com a mesma tool e os mesmos args.
					const last = params.messages.at(-1);
					expect(typeof last?.content === "string" ? last.content : "").toMatch(/call prepare_for_owner with this tool name and these exact args/);
					return call("c2", "tool_search", { query: "trello update card" });
				},
				(params) => {
					// A busca acha a escrita escondida, marcada como só-rascunho, com o exemplo do rascunho.
					const last = params.messages.at(-1);
					const text = typeof last?.content === "string" ? last.content : "";
					expect(text).toMatch(/mcp__trello__update_card\(card_id: string, list\?: string, comment\?: string\) \[connector Trello; needs the owner: only as a draft via prepare_for_owner\]/);
					expect(text).toContain('e.g. prepare_for_owner({"tool":"mcp__trello__update_card","args":{"card_id":"..."},"note":"..."})');
					return call("c3", PREPARE_FOR_OWNER_TOOL_NAME, { tool: UPDATE, args: ARGS, note: "Mover o cartão c-42 para Feito." });
				},
				say("Deixei para você aprovar."),
			],
			{ mcp, autonomy: BALANCED, ...routineText },
		);
		// A rotina não vê a escrita (nem no array nem no manifesto): o prompt fixo não muda.
		expect(offered(routine.requests[0]!)).not.toContain(UPDATE);
		expect(JSON.stringify(routine.requests[0]!.messages)).not.toContain(UPDATE);
		expect(routine.results[0]).toMatchObject({ name: UPDATE, ok: false });
		expect(routine.results[2]).toMatchObject({ name: PREPARE_FOR_OWNER_TOOL_NAME, ok: true, summary: PREPARED_DRAFT_RESULT("Trello: update card") });
		expect(routine.confirms).toHaveLength(1);
		expect(routine.confirms[0]).toMatchObject({ title: "Trello: update card?", confirmLabel: "Permitir", cancelLabel: "Agora não", callKey: toolCallKey(UPDATE, ARGS) });
		expect(routine.confirms[0]!.confirmId).toMatch(/^confirm-draft[0-9a-f]{8}-run-routine$/);
		expect(routine.confirms[0]!.description).toContain("card_id: c-42");
		// A intenção é a mesma `mcp-call` que a API executa no "Permitir", com os args exatos e marcada como rascunho.
		expect(db.intents).toHaveLength(1);
		expect(db.intents[0]!.payload).toMatchObject({
			action: "mcp-call",
			botId: "bot-a",
			mcpCall: { connectionId: "conn-trello", connectorName: "Trello", toolName: "update_card", exposedName: UPDATE, args: ARGS, runId: "run-routine", prepared: true },
		});
		expect(mcpCall).not.toHaveBeenCalled();
	});

	it("args do rascunho validados pelo schema do conector: campo desconhecido falha com a lista dos aceitos; nada é criado", async () => {
		const { mcp } = connectors();
		const routine = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: UPDATE, args: { ...ARGS, color: "red" }, note: "n" }), call("c2", PREPARE_FOR_OWNER_TOOL_NAME, { tool: UPDATE, args: { list: "Feito" }, note: "n" }), say("não deu")], { mcp, autonomy: BALANCED, ...routineText });
		expect(routine.results[0]).toMatchObject({ ok: false });
		expect(routine.results[0]!.summary).toMatch(/unknown field color \(accepted: card_id, list, comment\)/);
		expect(routine.results[1]!.summary).toMatch(/missing required card_id[\s\S]*Expected: mcp__trello__update_card\(card_id: string, list\?: string, comment\?: string\)/);
		expect(db.intents).toHaveLength(0);
		expect(routine.confirms).toHaveLength(0);
	});

	it("conector só-leitura não vira alvo; o filtro do run também vale", async () => {
		const { mcp } = connectors();
		const routine = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: "mcp__docs__search", args: { q: "x" }, note: "n" }), say("ok")], { mcp, autonomy: BALANCED, ...routineText });
		expect(routine.results[0]!.summary).toMatch(/mcp__docs__search is available in this run; call it directly/);
		const filtered = await runV3([call("c1", PREPARE_FOR_OWNER_TOOL_NAME, { tool: UPDATE, args: ARGS, note: "n" }), say("ok")], { mcp, autonomy: BALANCED, toolFilter: (name) => name !== UPDATE, ...routineText });
		expect(filtered.results[0]!.summary).toMatch(/cannot be prepared: no action in this run needs the owner's approval/);
		expect(db.intents).toHaveLength(0);
	});

	it("continuação depois do rascunho nunca executa o conector (a API já executou a aprovada, uma vez)", async () => {
		const { mcp, mcpCall } = connectors();
		const continuation = await runV3([call("c1", UPDATE, ARGS), call("c2", UPDATE, { ...ARGS, list: "Outra" }), say("feito")], {
			mcp,
			autonomy: BALANCED,
			runId: "run-cont",
			origin: "chat",
			humanTurn: false,
			restoredCheckpoint: { version: 2, messages: [{ role: "user", content: "[ok]" }], transcriptSeed: { fromRunId: "run-routine", resultContent: "x", shortContent: "x" } } as unknown as AgentRunCheckpoint,
			messages: [{ role: "user", content: "[Ação confirmada pelo usuário e JÁ EXECUTADA pelo sistema]" }],
		});
		expect(continuation.results.map((result) => result.ok)).toEqual([false, false]);
		expect(mcpCall).not.toHaveBeenCalled();
	});
});

describe("rascunho descartado ou ignorado vira nota interna (PR8e)", () => {
	const decisions = () => ({
		list: vi.fn(async () => [
			{ id: "m1", title: "Trello: update card?", decision: "dismissed" as const },
			{ id: "m2", title: "Enviar esta mensagem?", decision: "ignored" as const },
		]),
		markNoted: vi.fn(async () => 2),
	});
	const chatTurn = { origin: "chat", humanTurn: true, runId: "run-chat", messages: [{ role: "user" as const, content: "E aí, o que ficou pendente?" }] };

	it("o próximo run recebe a nota (sem balão) e só marca como dita depois que o modelo respondeu", async () => {
		const draftDecisions = decisions();
		const chat = await runV3(
			[
				() => {
					// Na hora da 1ª chamada a nota está no contexto e ainda não foi marcada.
					expect(draftDecisions.markNoted).not.toHaveBeenCalled();
					return say("Certo.");
				},
			],
			{ ...chatTurn, draftDecisions },
		);
		expect(chat.error).toBeUndefined();
		const texts = chat.requests[0]!.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
		expect(texts.some((text) => text.includes('The owner dismissed draft(s) you left for approval: "Trello: update card"'))).toBe(true);
		expect(texts.some((text) => text.includes('The owner did not answer the draft(s) you left for approval and sent another message instead: "Enviar esta mensagem"'))).toBe(true);
		expect(draftDecisions.markNoted).toHaveBeenCalledTimes(1);
		expect(draftDecisions.markNoted).toHaveBeenCalledWith(["m1", "m2"]);
		expect(chat.events.filter((event) => event.type === "confirm")).toHaveLength(0);
	});

	it("run que falha antes da 1ª resposta do modelo não consome a nota", async () => {
		const draftDecisions = decisions();
		const failed = await runV3([() => { throw new Error("provedor fora do ar (400)"); }], { ...chatTurn, draftDecisions });
		expect(failed.error).toBeDefined();
		expect(draftDecisions.list).toHaveBeenCalledTimes(1);
		expect(draftDecisions.markNoted).not.toHaveBeenCalled();
	});

	it("só chat e rotina da conversa leem a nota; e-mail recebido, webhook e outro bot não", async () => {
		for (const origin of ["email", "webhook", "bot"]) {
			const draftDecisions = decisions();
			await runV3([say("ok")], { origin, humanTurn: false, draftDecisions });
			expect(draftDecisions.list, origin).not.toHaveBeenCalled();
		}
		const routine = decisions();
		await runV3([say("ok")], { draftDecisions: routine });
		expect(routine.list).toHaveBeenCalledTimes(1);
		expect(routine.markNoted).toHaveBeenCalledWith(["m1", "m2"]);
	});
});
