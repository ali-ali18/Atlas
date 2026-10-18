import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse, SYSTEM_PROMPT } from "./computer-use.js";
import { executeShowImage } from "./tools/show-image.js";

vi.mock("./tools/show-image.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tools/show-image.js")>()),
	executeShowImage: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const answer: CompleteChatWithToolsResult = { model: "vision/model", message: { role: "assistant", content: "Uma flor azul." } };

async function replay(input: {
	canSeeUserImages: boolean;
	loadUserImage?: (id: string) => Promise<string | null>;
	describeUserImage?: (id: string) => Promise<{ description: string | null; costUsd?: number }>;
	request: string;
}) {
	let transport: CompleteChatWithToolsParams | undefined;
	let checkpoint: AgentRunCheckpoint | undefined;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "vision/model", apiKey: "test", runId: "run-image", userId: "user-a",
		origin: "chat",
		messages: [{ role: "user", content: input.request }],
		userImageArtifactIds: ["image-a"],
		canSeeUserImages: input.canSeeUserImages,
		loadUserImage: input.loadUserImage,
		describeUserImage: input.describeUserImage,
		sandboxEnabled: false,
		onEvent: () => undefined,
		onCheckpoint: async (value) => { checkpoint = value; },
		streamChat: async (params) => { transport = params; return answer; },
	});
	return { transport, checkpoint };
}

describe("F14 - visão do usuário", () => {
	it("replay do reenvio retoma cinco envios, mostra o sexto e bloqueia o sétimo", async () => {
		const remaining: number[] = [];
		vi.mocked(executeShowImage).mockImplementation(async (_args, ctx) => {
			remaining.push(ctx.remaining);
			if (ctx.remaining === 0) throw new Error("IMAGE_DISPLAY_LIMIT: limite de 6 imagens por execução; 0 vagas restantes.");
			await ctx.onImages({ type: "images", origin: "assistant", items: [{ artifactId: "screenshot-owned", mime: "image/jpeg", width: 100, height: 100 }] });
			return { summary: "Imagem mostrada", count: 1, remaining: ctx.remaining - 1 };
		});
		let checkpoint: AgentRunCheckpoint | undefined;
		const events: unknown[] = [];
		let calls = 0;
		await runComputerUse({
			manager: {} as SandboxManager, getSessionId: async () => "unused", model: "m", apiKey: "test",
			runId: "run-resume", userId: "user-a", origin: "chat", sandboxEnabled: false,
			messages: [{ role: "user", content: "Retorna aquela captura para eu ver" }],
			restoredCheckpoint: { version: 1, messages: [], nextStepIndex: 0, shownImageCount: 5 },
			onEvent: (event) => { events.push(event); }, onCheckpoint: async (value) => { checkpoint = value; },
			streamChat: async () => {
				calls += 1;
				return calls <= 2 ? { model: "m", message: { role: "assistant", content: null, tool_calls: [{ id: `show-${calls}`, type: "function", function: { name: "show_image", arguments: JSON.stringify({ source: "artifact", artifact_id: "screenshot-owned", caption: `envio ${calls}` }) } }] } } : answer;
			},
		});
		expect(remaining).toEqual([1, 0]);
		expect(checkpoint?.shownImageCount).toBe(6);
		expect(events.filter((event) => (event as { type: string }).type === "images")).toHaveLength(1);
		expect(JSON.stringify(events)).toContain("IMAGE_DISPLAY_LIMIT");
		expect(JSON.stringify(checkpoint)).not.toMatch(/data:image\/[^;]+;base64,/);
		expect(SYSTEM_PROMPT).toContain("Claim delivery only after show_image succeeds");
	});
	afterEach(() => { delete process.env.ATLAS_IMAGE_MODEL; });

	it("replay da foto: modelo com visão recebe imagem só no transporte; checkpoint guarda referência", async () => {
		const { transport, checkpoint } = await replay({
			request: "O que tem nessa foto?",
			canSeeUserImages: true,
			loadUserImage: async (id) => { expect(id).toBe("image-a"); return "data:image/png;base64,c2VudGluZWxh"; },
		});
		const serialized = JSON.stringify(transport?.messages);
		expect(serialized).toContain("data:image/png;base64,c2VudGluZWxh");
		expect(JSON.stringify(checkpoint)).toContain('"artifactId":"image-a"');
		expect(JSON.stringify(checkpoint)).not.toContain("c2VudGluZWxh");
	});

	it("sem visão usa descrição de apoio e nunca envia image_url", async () => {
		const { transport } = await replay({
			request: "O que tem nessa foto?", canSeeUserImages: false,
			describeUserImage: async () => ({ description: "Uma flor azul", costUsd: 0.002 }),
		});
		const serialized = JSON.stringify(transport?.messages);
		expect(serialized).toContain("Uma flor azul");
		expect(serialized).not.toContain("image_url");
	});

	it("sem visão e sem fallback comunica que não viu a foto", async () => {
		const { transport } = await replay({ request: "O que tem nessa foto?", canSeeUserImages: false });
		expect(JSON.stringify(transport?.messages)).toContain("cannot see images");
	});

	it("tool paga aparece com o modelo de imagem configurado, em qualquer idioma ou pedido", async () => {
		const plain = await replay({ request: "O que tem nessa foto?", canSeeUserImages: false });
		expect(plain.transport?.tools.some((tool) => tool.function.name === "generate_image")).toBe(false);
		process.env.ATLAS_IMAGE_MODEL = "image/model";
		const asked = await replay({ request: "Gera uma logo azul", canSeeUserImages: false });
		expect(asked.transport?.tools.some((tool) => tool.function.name === "generate_image")).toBe(true);
		const other = await replay({ request: "Qual é a capital da França?", canSeeUserImages: false });
		expect(other.transport?.tools.some((tool) => tool.function.name === "generate_image")).toBe(true);
		expect(SYSTEM_PROMPT).toContain("call show_image");
	});
});
