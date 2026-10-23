import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { applyComputerUseEventsToTranscript, type ComputerUseEvent } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { MISSING_ARTIFACT_NOTE } from "./execution/task-state.js";
import { jevSaying } from "./jev/test-support.js";

/**
 * Replay (LLM mockado) do caso real "a mensagem some: ele escreve de novo e some". O usuário pede o PDF da
 * Semana 2 do AVA; o bot repassa ao Bobinho (send_to_bot, assíncrono) e avisa "pedi pro Bobinho". Antes, a
 * cobrança do arquivo (MISSING_ARTIFACT_NOTE) fazia o modelo reescrever a resposta como "o Bobinho não me
 * respondeu, não criei nada" e o primeiro balão, nunca gravado, sumia no fim do run.
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	sendBotMessage: vi.fn(async () => ({ id: "m1", targetId: "bot-2", targetName: "Bobinho" })),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchMemoryEntries: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const verify = vi.hoisted(() => vi.fn(async () => null as string[] | null));
vi.mock("./jev/answer-verifier.js", () => ({
	verifyDraftAnswer: verify,
	verifierNote: () => "Answer check (automatic, once): rewrite.",
}));

type Ev = Record<string, unknown> & { type: string };
type Message = CompleteChatWithToolsParams["messages"][number];

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (content: string | null, ...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content, tool_calls: calls } });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const ASKED = "Pedi pro Bobinho montar o PDF da Semana 2 do AVA. Te aviso quando ele entregar.";
const WITHDRAWN =
	"Ali, ainda não há arquivo. O PDF da Semana 2 é trabalho do Bobinho, que não me respondeu, então não criei nada.";

async function run(input: { queue: CompleteChatWithToolsResult[]; bots?: number }) {
	const events: Ev[] = [];
	const requests: Message[][] = [];
	const queue = [...input.queue];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "me manda o PDF com o resumo da Semana 2 do AVA" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-1",
		runId: "run-1",
		origin: "chat",
		maxSteps: 8,
		contextEconomy: false,
		jev: jevSaying({ wants_file: 0.95 }),
		listBotRoster: async () => Array.from({ length: input.bots ?? 2 }, (_, i) => ({ id: `bot-${i + 1}` })),
		onEvent: (event) => {
			events.push(event as never);
		},
		streamChat: async (params, handlers) => {
			// Perguntas baratas de sim/não sobre a resposta (askFilePromise/askFileCorrection): "não".
			if (params.tools.length === 0 && params.toolChoice === "none") {
				return { model: "m", message: { role: "assistant", content: '{"promisesFile": false, "fixFile": false}' }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
			}
			requests.push(JSON.parse(JSON.stringify(params.messages)) as Message[]);
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			const text = next.message.content ?? "";
			for (let at = 0; at < text.length; at += 12) handlers?.onDelta?.(text.slice(at, at + 12));
			return { ...next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
		},
	} as never);
	const transcript = applyComputerUseEventsToTranscript([], events as unknown as ComputerUseEvent[]);
	return { result, events, requests, transcript };
}

describe("resposta já exibida não some (replay: arquivo repassado ao Bobinho)", () => {
	it("repassar o arquivo a outro bot encerra com 'pedi pro Bobinho', sem cobrança que reescreve a resposta", async () => {
		const { result, events, requests, transcript } = await run({
			queue: [
				turn(null, call("c1", "send_to_bot", { bot: "Bobinho", message: "Monte o PDF com o resumo da Semana 2 do AVA.", title: "PDF Semana 2" })),
				say(ASKED),
				// Se a cobrança voltasse, o modelo reescreveria assim (e o primeiro balão sumiria).
				say(WITHDRAWN),
			],
		});
		expect(result.text).toBe(ASKED);
		expect(requests.flat().some((message) => message.role === "system" && message.content === MISSING_ARTIFACT_NOTE)).toBe(false);
		expect(events.filter((event) => event.type === "assistant_discard")).toHaveLength(0);
		expect(transcript.filter((bubble) => bubble.text.trim()).map((bubble) => bubble.text)).toEqual([ASKED]);
	});

	it("sem repasse, a resposta reescrita pela cobrança do arquivo deixa o rascunho visível e recolhido, com o motivo", async () => {
		const { result, events, transcript } = await run({
			bots: 1,
			queue: [say(ASKED), say(WITHDRAWN)],
		});
		expect(result.text).toBe(WITHDRAWN);
		const discards = events.filter((event) => event.type === "assistant_discard");
		expect(discards).toHaveLength(1);
		expect(discards[0]).toMatchObject({ reason: "missing_file" });
		expect(String(discards[0]!.id)).toMatch(/-step-\d+$/);
		// O texto já lido continua na tela (recolhido como rascunho revisado) e a versão nova vem depois.
		expect(transcript.map((bubble) => ({ text: bubble.text, revised: bubble.revised }))).toEqual([
			{ text: ASKED, revised: "missing_file" },
			{ text: WITHDRAWN, revised: undefined },
		]);
	});

	it("o verificador só observa: a resposta já exibida fica como final, sem rascunho revisado", async () => {
		verify.mockResolvedValueOnce(["Your draft blames a tool that actually returned a successful result."]);
		const { result, events, transcript } = await run({
			queue: [
				turn(null, call("c1", "send_to_bot", { bot: "Bobinho", message: "Monte o PDF.", title: "PDF" })),
				say("Não consegui falar com o Bobinho."),
				say(ASKED),
			],
		});
		expect(result.text).toBe("Não consegui falar com o Bobinho.");
		expect(events.some((event) => event.type === "assistant_discard")).toBe(false);
		expect(transcript.filter((bubble) => bubble.text.trim()).map((bubble) => [bubble.text, bubble.revised])).toEqual([
			["Não consegui falar com o Bobinho.", undefined],
		]);
	});
});
