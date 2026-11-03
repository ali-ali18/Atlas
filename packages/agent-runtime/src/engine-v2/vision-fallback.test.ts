/**
 * Motor v2: o screenshot automático da leitura é reservado por passo (`claimVisionFallback` do run.ts). Duas leituras
 * cortadas no MESMO passo gastam uma imagem só; o passo seguinte tem a sua. Tela de login nunca anexa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { runEngineV2 } from "./run.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
}));

let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: `v${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const cappedRead = { url: "https://video.test/watch", title: "Video", view: "outline", text: "# Video\nComments", offset: 0, limit: 8000, totalLength: 20, truncated: false, nextOffset: null, frames: 1, collapsed: 0, capped: true };
// A 1ª chamada de uma tool adiada só a carrega ("not loaded; call it again"): este passo não conta.
const load = () => turn([call("browser_read")]);
const snapshot = (lines: string[]) => async () => ({ url: "https://video.test/watch", title: "Video", total: lines.length, offset: 0, limit: 100, nextOffset: null, lines });

async function run(script: CompleteChatWithToolsResult[], manager: Record<string, unknown> = {}, extra: Partial<Parameters<typeof runEngineV2>[0]> = {}) {
	const events: ComputerUseEvent[] = [];
	const persisted: string[] = [];
	const queue = [...script];
	await runEngineV2(
		{
			manager: {
				execScreen: async () => ({ width: 1280, height: 720 }),
				execScreenshot: async () => JPEG,
				execBrowserRead: async () => cappedRead,
				execBrowserSnapshot: snapshot(['[e1] button "Perguntar"']),
				...manager,
			} as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-vision-v2",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "leia o vídeo e o painel" }],
			timeZone: "America/Sao_Paulo",
			persistScreenshot: async (b64: string) => {
				persisted.push(b64);
				return `art-${persisted.length}`;
			},
			loadScreenshot: async () => `data:image/jpeg;base64,${JPEG.toString("base64")}`,
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (_params: CompleteChatWithToolsParams) => queue.shift() ?? say("fim"),
			...extra,
		},
		{ profile: "chat", promotable: false },
	);
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	return { persisted, results };
}

beforeEach(() => vi.clearAllMocks());

describe("motor v2: claimVisionFallback", () => {
	it("duas leituras cortadas no mesmo passo gastam uma imagem; o passo seguinte tem a sua", async () => {
		const { persisted, results } = await run([
			load(),
			turn([call("browser_read"), call("browser_read", { view: "text" })]),
			turn([call("browser_read")]),
			say("fim"),
		]);
		expect(persisted).toHaveLength(2);
		// Das 3 leituras reais, a 2ª do mesmo passo não leva imagem.
		const reads = results.filter((r) => r.summary.includes("chars 0-"));
		expect(reads).toHaveLength(3);
		expect(reads.map((r) => r.summary.includes("Vision fallback"))).toEqual([true, false, true]);
	});

	it("modelo sem visão: nenhuma imagem e a nota de leitura cortada não manda tirar screenshot", async () => {
		const { persisted, results } = await run([load(), turn([call("browser_read")]), say("fim")], {}, { canSeeUserImages: false });
		expect(persisted).toHaveLength(0);
		const read = results.find((r) => r.summary.includes("chars 0-"))?.summary ?? "";
		expect(read).not.toContain("Vision fallback");
		expect(read).toContain("The page was cut at the reading cap; use browser_find");
		expect(read).not.toContain("may not include what you triggered");
	});

	it("tela com campo de senha: nem anexa nem gasta a reserva do passo (a leitura seguinte, sem senha, ainda anexa)", async () => {
		let pass = 0;
		const { persisted } = await run(
			[load(), turn([call("browser_read")]), turn([call("browser_read")]), say("fim")],
			{ execBrowserSnapshot: async () => snapshot(++pass === 1 ? ['[e1] textbox "Senha" (campo de senha: nunca preencha)'] : ['[e1] button "Perguntar"'])() },
		);
		// 1º passo: a tela tinha senha (nada anexado); 2º passo: tela comum (anexa).
		expect(persisted).toHaveLength(1);
	});
});
