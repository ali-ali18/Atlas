import { describe, expect, it, vi } from "vitest";
import { anthropicRequestBody, type CompleteChatWithToolsParams, type CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { TRANSCRIPT_SLOT, type SerializedLlmMessage, type ToolCacheState } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildTranscriptHistory, cleanTranscript, namespaceToolCallIds } from "./context/transcript.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Ferramentas congeladas na conversa (cache de prompt): o roteador relê cada fala, mas o grupo do turno anterior
 * segue carregado. Turnos seguidos sem grupo novo mandam o MESMO array de tools e o MESMO prompt de sistema; grupo
 * novo entra no fim, sem reordenar o que já foi enviado.
 */
const MODEL = "anthropic/claude-sonnet-5.5";
const say = (content: string): CompleteChatWithToolsResult => ({ model: MODEL, message: { role: "assistant", content } });

type Checkpoint = { llmMessages?: SerializedLlmMessage[]; loadedTools?: string[]; toolCache?: ToolCacheState };
type Prior = { runId: string; reply: string; last: Checkpoint };

async function turn(input: { runId: string; user: string; reply?: string; prior?: Prior; carryCache?: boolean; script?: CompleteChatWithToolsResult[] }) {
	const requests: CompleteChatWithToolsParams[] = [];
	const checkpoints: Checkpoint[] = [];
	const priorTranscript = input.prior
		? buildTranscriptHistory({
				transcript: namespaceToolCallIds(cleanTranscript(input.prior.last.llmMessages, { model: MODEL })!, input.prior.runId),
				after: [{ role: "assistant", content: input.prior.reply }, { role: "user", content: input.user }],
				objective: input.user,
			})
		: undefined;
	const reply = input.reply ?? "Certo.";
	const script = [...(input.script ?? [])];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: MODEL,
		runId: input.runId,
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-cache",
		origin: "chat",
		contextEconomy: true,
		maxSteps: 4,
		priorTranscript,
		priorLoadedTools: input.prior?.last.loadedTools,
		...(input.carryCache === false ? {} : { priorToolCache: input.prior?.last.toolCache }),
		messages: [...(priorTranscript ? [{ role: "system" as const, content: TRANSCRIPT_SLOT }] : []), { role: "user", content: input.user }],
		onEvent: () => undefined,
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as Checkpoint);
		},
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params)) as CompleteChatWithToolsParams);
			return script.shift() ?? say(reply);
		},
	});
	return { requests, first: requests[0]!, lastRequest: requests.at(-1)!, prior: { runId: input.runId, reply, last: checkpoints.at(-1)! } satisfies Prior };
}

const names = (params: CompleteChatWithToolsParams) => params.tools.map((tool) => tool.function.name);
const system = (params: CompleteChatWithToolsParams) => String(params.messages[0]!.content);
/** Parte estável do sistema (a data e hora vai numa camada efêmera fora dele). */
const stableSystem = (params: CompleteChatWithToolsParams) => system(params);
const anthropic = (params: CompleteChatWithToolsParams) => {
	const body = anthropicRequestBody(params, "claude-sonnet-5.5");
	return JSON.stringify({ tools: body.tools, system: body.system }, (key, value) => (key === "cache_control" ? undefined : value));
};

describe("ferramentas congeladas na conversa", () => {
	it("turnos seguidos sem grupo novo mandam tools e sistema idênticos (byte a byte); antes o grupo saía", async () => {
		const one = await turn({ runId: "run-t1", user: "me lembra amanhã às 9h de ligar pro fornecedor", reply: "Lembrete criado." });
		expect(names(one.first)).toContain("propose_routine");
		expect(one.prior.last.toolCache).toMatchObject({ turn: 1, segments: [expect.arrayContaining(["routines"])] });

		const two = await turn({ runId: "run-t2", user: "obrigado", prior: one.prior });
		const three = await turn({ runId: "run-t3", user: "valeu, era só isso", prior: two.prior });
		for (const next of [two, three]) {
			expect(names(next.first)).toEqual(names(one.lastRequest));
			expect(JSON.stringify(next.first.tools)).toBe(JSON.stringify(one.lastRequest.tools));
			expect(system(next.first)).toBe(system(one.lastRequest));
			expect(anthropic(next.first)).toBe(anthropic(one.lastRequest));
		}
		expect(three.prior.last.toolCache).toMatchObject({ turn: 3, lastUsed: { routines: 1 } });

		// Sem o estado congelado (comportamento antigo), o "obrigado" perdia as tools de rotina e mudava o prefixo.
		const legacy = await turn({ runId: "run-t2b", user: "obrigado", prior: one.prior, carryCache: false });
		expect(names(legacy.first)).not.toContain("propose_routine");
		expect(JSON.stringify(legacy.first.tools)).not.toBe(JSON.stringify(one.lastRequest.tools));
	});

	it("grupo novo entra no fim: tools e procedimentos anteriores ficam no mesmo lugar", async () => {
		const one = await turn({ runId: "run-n1", user: "me lembra amanhã às 9h de ligar pro fornecedor" });
		const two = await turn({ runId: "run-n2", user: "agora me gera um pdf com o resumo", prior: one.prior });
		const before = names(one.lastRequest);
		const after = names(two.first);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBeGreaterThan(before.length);
		expect(after).toContain("create_file");
		// O sistema do turno 2 começa com o do turno 1 (parte estável): o bloco novo vai no fim.
		expect(stableSystem(two.first).startsWith(stableSystem(one.lastRequest))).toBe(true);
		expect(two.prior.last.toolCache!.segments).toEqual([expect.arrayContaining(["routines"]), expect.arrayContaining(["files"])]);
		// E o turno 3 sem nada novo repete o turno 2.
		const three = await turn({ runId: "run-n3", user: "obrigado", prior: two.prior });
		expect(JSON.stringify(three.first.tools)).toBe(JSON.stringify(two.lastRequest.tools));
		expect(system(three.first)).toBe(system(two.lastRequest));
	});

	it("grupo carregado no meio do turno 1 segue no turno 2 sem mudar tools nem sistema", async () => {
		const call: CompleteChatWithToolsResult = { model: MODEL, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_file", arguments: "{}" } }] } };
		const one = await turn({ runId: "run-m1", user: "oi, tudo bem?", script: [call] });
		expect(names(one.first)).not.toContain("create_file");
		expect(names(one.lastRequest)).toContain("create_file");
		expect(system(one.lastRequest)).toBe(system(one.first));
		const two = await turn({ runId: "run-m2", user: "obrigado", prior: one.prior });
		expect(JSON.stringify(two.first.tools)).toBe(JSON.stringify(one.lastRequest.tools));
		expect(system(two.first)).toBe(system(one.lastRequest));
	});

	it("grupo sem uso por vários turnos sai (o contexto volta a encolher)", async () => {
		let prev = (await turn({ runId: "run-e0", user: "me lembra amanhã às 9h de ligar pro fornecedor" })).prior;
		const sizes: number[] = [];
		const withRoutines: boolean[] = [];
		for (let index = 1; index <= 6; index += 1) {
			const next = await turn({ runId: `run-e${index}`, user: "obrigado", prior: prev });
			withRoutines.push(names(next.first).includes("propose_routine"));
			sizes.push(JSON.stringify(next.first.tools).length);
			prev = next.prior;
		}
		// Usado no turno 1: fica nos turnos 2..6 e sai no 7.
		expect(withRoutines).toEqual([true, true, true, true, true, false]);
		expect(sizes[5]).toBeLessThan(sizes[0]!);
	});
});
