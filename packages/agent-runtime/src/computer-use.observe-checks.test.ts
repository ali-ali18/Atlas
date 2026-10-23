import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import type { JevAsk, JevDecisionRecord } from "./jev/decide.js";

/**
 * Checagens que só observam a resposta final (correção de arquivo e verificador Jev em sombra): rodam
 * juntas e, com `backgroundObserveChecks`, não seguram o fim do run; o uso delas chega depois em
 * `observeChecks`. LLM e Jev mockados.
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
		id: `art-${Math.random().toString(36).slice(2, 8)}`,
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: "run-observe",
		conversationId: "conv-observe",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
}));

vi.mock("./files/pdf-chromium.js", () => ({
	printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake")),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls } });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const NOTE = call("n1", "research_note", {
	sourceRef: "https://example.test/pricing",
	findings: "The Pro plan costs 20 dollars per month and includes 5 seats.",
	keyFacts: ["Pro plan: US$ 20 per month", "5 seats"],
	confidence: "high",
});
const FILE = call("f1", "create_file", { filename: "planos.pdf", content: "# Planos\n\nPlano Pro: US$ 20 por mês, 5 assentos." });
const FIX_FILE_CALL_TOKENS = 60;
const CHECK_USAGE = { promptTokens: 20, completionTokens: 4, totalTokens: 24, costUsd: 0.0001 };

function setup(options: { background?: boolean; failFileCheck?: boolean; failJev?: boolean }) {
	const fileCheck = deferred<void>();
	const jevAnswer = deferred<void>();
	const started: string[] = [];
	const decisions: JevDecisionRecord[] = [];
	const queue = [turn(NOTE), turn(FILE), say("Pronto, o PDF com os planos está anexado.")];
	const ask: JevAsk = vi.fn(async ({ questions }) => {
		started.push("jev");
		await jevAnswer.promise;
		if (options.failJev) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		return { model: "jev", answers: Object.fromEntries(Object.keys(questions).map((key) => [key, 0])), durationMs: 1 };
	});
	const running = runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "Pesquise os planos do produto e gere um PDF com o comparativo." }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-observe",
		runId: "run-observe",
		origin: "chat",
		maxSteps: 12,
		jev: { ask, modes: { verify: "on" }, onDecision: (record) => decisions.push(record) },
		...(options.background ? { backgroundObserveChecks: true } : {}),
		onEvent: () => {},
		streamChat: async (params) => {
			if (params.maxOutputTokens === FIX_FILE_CALL_TOKENS) {
				started.push("file");
				await fileCheck.promise;
				if (options.failFileCheck) throw new Error("provedor fora");
				return { model: "cheap", message: { role: "assistant", content: '{"fixFile": false}' }, usage: CHECK_USAGE };
			}
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return { ...next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
		},
	} as never);
	return { running, started, decisions, release: () => (fileCheck.resolve(), jevAnswer.resolve()) };
}

describe("checagens de observação da resposta final", () => {
	it("sem background: rodam juntas e o uso entra no total antes de devolver (como antes)", async () => {
		const { running, started, release } = setup({});
		let settled = false;
		void running.finally(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(started.sort()).toEqual(["file", "jev"]));
		await tick();
		expect(settled).toBe(false);
		release();
		const result = await running;
		// 3 passos (15 cada) + a checagem do arquivo (24).
		expect(result.usage.totalTokens).toBe(3 * 15 + 24);
		expect(result.observeChecks).toBeUndefined();
	});

	it("com background: o run devolve sem esperar e o uso das checagens chega depois", async () => {
		const { running, started, decisions, release } = setup({ background: true });
		const result = await running;
		expect(result.text).toBe("Pronto, o PDF com os planos está anexado.");
		expect(result.usage.totalTokens).toBe(3 * 15);
		expect(started.sort()).toEqual(["file", "jev"]);
		expect(result.observeChecks).toBeInstanceOf(Promise);
		let lateSettled = false;
		void result.observeChecks!.then(() => {
			lateSettled = true;
		});
		await tick();
		expect(lateSettled).toBe(false);
		release();
		const late = await result.observeChecks!;
		expect(late).toMatchObject({ promptTokens: 20, completionTokens: 4, totalTokens: 24, costUsd: 0.0001 });
		// A decisão do verificador (sombra) é registrada quando ele termina.
		expect(decisions.some((record) => record.feature === "verify")).toBe(true);
	});

	it("com background: falha das checagens não vira rejeição sem dono", async () => {
		const { running, release } = setup({ background: true, failFileCheck: true, failJev: true });
		const result = await running;
		release();
		await expect(result.observeChecks!).resolves.toBeNull();
	});
});
