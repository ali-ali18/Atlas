import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const answer: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "ok" } };

async function replay(extra: Partial<Parameters<typeof runComputerUse>[0]>, request = "Oi") {
	const transports: CompleteChatWithToolsParams[] = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "m", apiKey: "test", runId: "run-config", userId: "user-a", origin: "chat",
		messages: [{ role: "user", content: request }],
		sandboxEnabled: false,
		onEvent: () => undefined,
		streamChat: async (params) => { transports.push(params); return answer; },
		...extra,
	});
	return transports;
}

afterEach(() => vi.unstubAllEnvs());

describe("configuração da conta chega à lib por parâmetro", () => {
	it("prazos, reserva e teto de saída vão ao streamChat; o env fica só como último recurso", async () => {
		vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "2048");
		const [call] = await replay({
			modelCallTimeoutMs: 45_000,
			firstEventTimeoutMs: 15_000,
			idleTimeoutMs: 10_000,
			fallbackModels: ["fb/one"],
			maxOutputTokens: 16_384,
		});
		expect(call).toMatchObject({
			timeoutMs: 45_000,
			firstEventTimeoutMs: 15_000,
			idleTimeoutMs: 10_000,
			fallbackModels: ["fb/one"],
			maxOutputTokens: 16_384,
		});
	});

	it("sem parâmetros nada muda: a lib continua lendo o env", async () => {
		vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "4096");
		const [call] = await replay({});
		expect(call?.timeoutMs).toBeUndefined();
		expect(call?.firstEventTimeoutMs).toBeUndefined();
		expect(call?.idleTimeoutMs).toBeUndefined();
		expect(call?.fallbackModels).toBeUndefined();
		expect(call?.maxOutputTokens).toBe(4096);
	});

	it("o modelo de imagem da conta expõe a tool sem depender do env", async () => {
		vi.stubEnv("ATLAS_IMAGE_MODEL", "");
		const without = await replay({}, "Gera uma logo azul");
		expect(without[0]?.tools.some((tool) => tool.function.name === "generate_image")).toBe(false);
		const withModel = await replay({ imageModel: "image/model" }, "Gera uma logo azul");
		expect(withModel[0]?.tools.some((tool) => tool.function.name === "generate_image")).toBe(true);
	});
});
