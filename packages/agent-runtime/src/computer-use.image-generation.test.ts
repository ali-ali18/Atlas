import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

/** Pedido de imagem de ponta a ponta no loop: configuração da conta, autonomia, confirmação de custo e aviso sem modelo. */

const { generateImages, saveSkillPendingIntent } = vi.hoisted(() => ({
	generateImages: vi.fn(async () => ({ images: [{ bytes: Buffer.from("raw"), mime: "image/png" }], costUsd: 0.04 })),
	saveSkillPendingIntent: vi.fn(async () => undefined),
}));

vi.mock("@workspace/llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("@workspace/llm")>()), generateImages }));
vi.mock("./images/process.js", () => ({
	processImageForStorage: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png", width: 1024, height: 1024 })),
}));
vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchMemoryEntries: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	saveSkillPendingIntent,
	persistUserArtifact: vi.fn(async () => ({ id: "art-img-1" })),
}));

const imageCall = (args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: "ig1", type: "function" as const, function: { name: "generate_image", arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };

async function run(extra: Record<string, unknown>, text = "gera uma imagem de um gato astronauta") {
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const offered: string[][] = [];
	const queue = [imageCall({ prompt: "gato astronauta", aspect_ratio: "16:9" }), done];
	await runComputerUse({
		manager: {} as SandboxManager, getSessionId: async () => { throw new Error("sem sandbox"); }, sandboxEnabled: false,
		model: "m", apiKey: "test-key", messages: [{ role: "user", content: text }],
		botId: "bot-1", userId: "user-1", conversationId: "conv-1", runId: "run-img", origin: "chat", maxSteps: 4,
		...extra,
		onEvent: (event) => { events.push(event as never); },
		streamChat: async (params) => { offered.push(params.tools.map((t) => t.function.name)); return queue.shift()!; },
	});
	return { events, offered };
}
const result = (events: Array<Record<string, unknown> & { type: string }>) => events.find((e) => e.type === "tool_result" && e.name === "generate_image") as { ok: boolean; summary: string };

describe("generate_image no loop", () => {
	it("modelo da conta + autonomia autônoma: gera com modelo e proporção, entrega as imagens", async () => {
		generateImages.mockClear();
		const { events, offered } = await run({ imageModel: "bytedance-seed/seedream-4.5", autonomy: { level: "autonomous", exceptions: [] } });
		expect(offered[0]).toContain("generate_image");
		expect(generateImages).toHaveBeenCalledWith(expect.objectContaining({ model: "bytedance-seed/seedream-4.5", prompt: "gato astronauta", aspectRatio: "16:9", n: 1, apiKey: "test-key" }));
		expect(result(events).ok).toBe(true);
		// o modelo recebe o id da imagem para usar como fundo/figura de slide
		expect(result(events).summary).toContain("Image id: art-img-1");
		expect(events.find((e) => e.type === "images")).toMatchObject({ origin: "assistant", items: [{ artifactId: "art-img-1" }] });
	});

	it("autonomia padrão (equilibrado): pede confirmação de custo e não gera ainda", async () => {
		generateImages.mockClear();
		saveSkillPendingIntent.mockClear();
		const { events } = await run({ imageModel: "bytedance-seed/seedream-4.5" });
		expect(generateImages).not.toHaveBeenCalled();
		expect(saveSkillPendingIntent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ action: "generate-image", imageGeneration: expect.objectContaining({ prompt: "gato astronauta", aspectRatio: "16:9" }) }) }));
		expect(events.find((e) => e.type === "confirm")).toMatchObject({ title: "Gerar imagem?" });
	});

	it("sem modelo configurado: a tool avisa onde configurar em vez de sumir", async () => {
		vi.stubEnv("ATLAS_IMAGE_MODEL", "");
		generateImages.mockClear();
		const { events } = await run({ autonomy: { level: "autonomous", exceptions: [] } });
		expect(generateImages).not.toHaveBeenCalled();
		const outcome = result(events);
		expect(outcome.ok).toBe(false);
		expect(outcome.summary).toContain("Configurações › Modelos");
		vi.unstubAllEnvs();
	});
});
