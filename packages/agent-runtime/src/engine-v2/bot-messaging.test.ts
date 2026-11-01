import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { sendBotMessage } from "@workspace/db";
import { BOT_MESSAGE_MAX_DEPTH, type ComputerUseEvent } from "@workspace/shared";
import { buildEngineV2Catalog } from "./catalog.js";
import { runEngineV2, type EngineV2Options } from "./run.js";

/**
 * Paridade de bot→bot no v2: `send_to_bot` e `decide_bot_pending` aparecem nas mesmas condições do v1 (2+ bots do
 * dono, chat ou bot→bot, decisão só ligada), os pedidos abertos entram no prompt só quando existem, e o anti-loop do
 * db (profundidade da cadeia, máximo de envios por run) continua valendo porque o handler é o mesmo.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		sendBotMessage: vi.fn(async () => ({ id: "m1", targetId: "bot-2", targetName: "Bia" })),
		getBotProfile: vi.fn(async () => ({ description: "configurado" })),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		getConversationUntrustedAt: vi.fn(async () => null),
		searchMemoryEntries: vi.fn(async () => []),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });
const two = [{ id: "bot-1" }, { id: "bot-2" }];

async function run(input: {
	origin?: string;
	bots?: Array<{ id: string; isPrimary?: boolean }>;
	script: CompleteChatWithToolsResult[];
	decide?: boolean;
	open?: NonNullable<Parameters<typeof runEngineV2>[0]["openBotRequests"]>;
	text?: string;
	group?: boolean;
	options?: Partial<EngineV2Options>;
}) {
	const events: ComputerUseEvent[] = [];
	const queue = [...input.script];
	const requests: Array<{ system: string; toolNames: string[] }> = [];
	const result = await runEngineV2(
		{
			manager: {} as SandboxManager,
			getSessionId: async () => "x",
			sandboxEnabled: false,
			model: "m",
			apiKey: "t",
			messages: [{ role: "user", content: input.text ?? "peça o saldo pra Bia" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			origin: (input.origin ?? "chat") as "chat",
			autonomy: { level: "balanced", exceptions: [] } as never,
			...(input.group ? {} : { listBotRoster: async () => input.bots ?? two }),
			decideForOtherBots: input.decide,
			openBotRequests: input.open,
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (params) => {
				requests.push({
					system: params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"),
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
				});
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		},
		{ profile: "chat", ...input.options },
	);
	return { events, requests, result, results: events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_result" }> => e.type === "tool_result") };
}

beforeEach(() => vi.clearAllMocks());

describe("v2: send_to_bot e decide_bot_pending no catálogo (mesmas condições do v1)", () => {
	it("chat e bot→bot com 2+ bots expõem send_to_bot; com um bot só, em rotina e em grupo não", async () => {
		for (const origin of ["chat", "bot"]) {
			const { requests } = await run({ origin, script: [say("ok")] });
			expect(requests[0]!.toolNames, origin).toContain("send_to_bot");
		}
		expect((await run({ bots: [{ id: "bot-1" }], script: [say("ok")] })).requests[0]!.toolNames).not.toContain("send_to_bot");
		expect((await run({ origin: "routine", script: [say("ok")] })).requests[0]!.toolNames).not.toContain("send_to_bot");
		// grupo: o worker não passa `listBotRoster` (como no v1)
		expect((await run({ group: true, script: [say("ok")] })).requests[0]!.toolNames).not.toContain("send_to_bot");
	});

	it("decide_bot_pending só com a decisão ligada no bot, 2+ bots e origem chat ou bot", async () => {
		expect((await run({ script: [say("ok")] })).requests[0]!.toolNames).not.toContain("decide_bot_pending");
		for (const origin of ["chat", "bot"]) {
			expect((await run({ origin, decide: true, script: [say("ok")] })).requests[0]!.toolNames, origin).toContain("decide_bot_pending");
		}
		expect((await run({ decide: true, bots: [{ id: "bot-1" }], script: [say("ok")] })).requests[0]!.toolNames).not.toContain("decide_bot_pending");
		expect((await run({ origin: "routine", decide: true, script: [say("ok")] })).requests[0]!.toolNames).not.toContain("decide_bot_pending");
	});

	it("o filtro de tools do run vale (ajudante e toolFilter nunca ganham envio entre bots)", () => {
		const names = (extra: Partial<Parameters<typeof buildEngineV2Catalog>[0]>) =>
			buildEngineV2Catalog({
				origin: "chat", userId: "user-1", sandboxEnabled: false, autonomy: { level: "balanced", exceptions: [] } as never, mcp: null, apiConnector: false,
				attachments: { present: false }, allowProfileUpdate: false, hasImageAttachments: false, routerMessages: [], lastUserMessage: "oi",
				botMessaging: { botCount: 2, decideForOtherBots: true }, ...extra,
			}).tools.map((tool) => tool.function.name);
		expect(names({})).toEqual(expect.arrayContaining(["send_to_bot", "decide_bot_pending"]));
		expect(names({ helper: true })).not.toContain("send_to_bot");
		expect(names({ toolFilter: (name) => name !== "send_to_bot" })).not.toContain("send_to_bot");
		expect(names({ botMessaging: undefined })).not.toContain("send_to_bot");
	});
});

describe("v2: pedidos abertos de outros bots no prompt", () => {
	const open = [{ botName: "Bobinho", title: "PDF da Semana 2", status: "delivered", createdAt: new Date(Date.now() - 45 * 60_000) }] as never;

	it("com pedidos em aberto o bloco chega ao modelo (igual ao v1); sem pedidos o prompt não muda", async () => {
		const withOpen = await run({ open, script: [say("Ainda espero o Bobinho.")] });
		expect(withOpen.requests[0]!.system).toContain("[open_bot_requests]");
		expect(withOpen.requests[0]!.system).toContain('Bobinho: "PDF da Semana 2"');
		const without = await run({ open: [], script: [say("ok")], text: "Bom dia", bots: [{ id: "bot-1" }] });
		expect(without.requests[0]!.system).not.toContain("[open_bot_requests]");
		const bare = await run({ script: [say("ok")], text: "Bom dia", bots: [{ id: "bot-1" }] });
		expect(without.requests[0]!.system).toBe(bare.requests[0]!.system);
	});
});

describe("v2: execução e anti-loop pelo mesmo handler do v1", () => {
	it("send_to_bot executa com dono, bot e run do contexto e devolve delivered, com o mesmo evento do v1", async () => {
		const { results, result } = await run({ script: [toolCall("c1", "send_to_bot", { bot: "Bia", message: "qual o saldo?", title: "Saldo" }), say("Pedi pra Bia.")] });
		expect(sendBotMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", fromBotId: "bot-1", fromRunId: "run-1", bot: "Bia" }));
		expect(results[0]).toMatchObject({ name: "send_to_bot", ok: true });
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ delivered: true, target: "Bia" });
		expect(result.stop).toEqual({ reason: "answered" });
	});

	it("limite de profundidade/envios do db volta ao modelo como erro honesto, sem derrubar o run", async () => {
		const { BotMessageError } = await import("@workspace/db");
		vi.mocked(sendBotMessage).mockRejectedValueOnce(new BotMessageError(`Limite de ${BOT_MESSAGE_MAX_DEPTH} saltos entre bots atingido nesta cadeia. Responda com o que você tem; não encaminhe mais.`));
		const { results, result } = await run({ origin: "bot", script: [toolCall("c1", "send_to_bot", { bot: "Caio", message: "repassa" }), say("Respondo com o que tenho.")] });
		expect(results[0]).toMatchObject({ name: "send_to_bot", ok: false });
		expect(results[0]!.summary).toMatch(/Limite de 3 saltos/);
		expect(result.text).toBe("Respondo com o que tenho.");
		expect(result.stop).toEqual({ reason: "answered" });
	});
});
