import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { PersistUserArtifactInput } from "@workspace/db";
import type { SandboxManager } from "@workspace/sandbox";
import { openPptx } from "./files/deck/pptx-zip.fixtures.js";
import { runComputerUse } from "./computer-use.js";

/**
 * Replay de ponta a ponta com LLM mockado: pedido de apresentação com capa gerada, deck de layout livre e
 * conferência visual. O banco, a geração de imagem e a sandbox são simulados; o desenho do pptx é o real.
 */

const store = vi.hoisted(() => new Map<string, { bytes: Uint8Array; kind: string; userId: string; conversationId?: string | null }>());
const { generateImages } = vi.hoisted(() => ({ generateImages: vi.fn() }));

vi.mock("@workspace/llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("@workspace/llm")>()), generateImages }));
vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "Configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchMemoryEntries: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	persistUserArtifact: vi.fn(async (input: PersistUserArtifactInput) => {
		const id = `art-${store.size + 1}`;
		store.set(id, { bytes: input.bytes, kind: input.kind, userId: input.userId, conversationId: input.conversationId });
		return { id, kind: input.kind, meta: { mime: input.mime }, runId: input.runId ?? null, conversationId: input.conversationId ?? null, createdAt: new Date() };
	}),
	// Escopo do dono: a imagem de outro usuário nunca é devolvida.
	loadArtifactForUser: vi.fn(async (id: string, userId: string) => {
		const row = store.get(id);
		return row && row.userId === userId ? { id, kind: row.kind, bytes: Buffer.from(row.bytes), conversationId: row.conversationId ?? null, meta: { mime: "image/png" } } : null;
	}),
	listGeneratedImageIds: vi.fn(async () => []),
}));

const call = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };

async function pagePng(): Promise<Uint8Array> {
	return new Uint8Array(await sharp({ create: { width: 40, height: 22, channels: 3, background: "#ffffff" } }).png().toBuffer());
}

async function replay(input: { text: string; script: CompleteChatWithToolsResult[]; canSeeUserImages?: boolean; withRunner?: boolean }) {
	store.clear();
	const photo = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#bcd3c6" } }).png().toBuffer();
	generateImages.mockReset();
	generateImages.mockResolvedValue({ images: [{ bytes: photo, mime: "image/png" }], costUsd: 0.04 });
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const files: Array<Record<string, unknown>> = [];
	const requests: Array<{ tools: ChatTool[]; vision: number }> = [];
	const queue = [...input.script];
	const runPython = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "", truncated: false, durationMs: 3, outputs: [], omitted: [], inputNames: [], crashed: false, previews: [{ name: "slide-1.png", bytes: await pagePng() }] }));
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-deck",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-1",
		origin: "chat",
		contextEconomy: true,
		autonomy: { level: "autonomous", exceptions: [] },
		imageModel: "img-model",
		canSeeUserImages: input.canSeeUserImages,
		createFileDeps: {
			nextVersion: vi.fn(async () => 1),
			countRunFiles: vi.fn(async () => 0),
			...(input.withRunner === false ? {} : { runPython }),
		},
		messages: [{ role: "user", content: input.text }],
		maxSteps: 6,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
			if (event.type === "file") files.push(event as never);
		},
		streamChat: async (params) => {
			requests.push({ tools: JSON.parse(JSON.stringify(params.tools)) as ChatTool[], vision: JSON.stringify(params.messages).split("Imagem(ns) gerada(s) pelo código").length - 1 });
			return queue.shift() ?? done;
		},
	});
	return { results, files, requests, runPython };
}

const DECK = {
	filename: "pitch-japones.pptx",
	slides: [
		{ layout: "title", title: "Atlas Agro", subtitle: "Pitch 2027", background: { image: "ART" } },
		{
			layout: "free",
			name: "Problema",
			elements: [
				{ type: "text", x: 0.8, y: 0.6, w: 11.5, h: 1, text: "O produtor perde 3 dias por safra em planilhas", size: 34, bold: true, font: "heading" },
				{ type: "shape", shape: "rounded_rect", x: 0.8, y: 2, w: 3.6, h: 3, fill: "surface", stroke: "border" },
				{ type: "icon", name: "wheat", x: 1.1, y: 2.3, w: 0.8, h: 0.8, color: "accent" },
				{ type: "text", x: 1.1, y: 3.3, w: 3, h: 1.2, text: "Safra sem controle de custos", size: 20 },
			],
		},
	],
};

describe("apresentação de ponta a ponta (LLM mockado)", () => {
	it("gera a capa, usa a imagem como fundo em outra chamada e confere as páginas", async () => {
		const prompt = "Faz uma apresentação de pitch com capa no estilo minimalista japonês";
		const first = await replay({ text: prompt, canSeeUserImages: true, script: [call("g1", "generate_image", { prompt: "minimalismo japonês, tons suaves, área calma", aspect_ratio: "16:9" })] });
		// passo 1: o guia, o create_file e o generate_image já estão no pedido
		expect(first.requests[0]!.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["create_file", "generate_image", "inspect_presentation"]));
		const image = first.results.find((r) => r.name === "generate_image")!;
		expect(image.ok).toBe(true);
		// o modelo recebe o id da imagem gerada (é o que ele usa no background)
		const id = /Image id: (art-\d+)/.exec(image.summary)?.[1];
		expect(id).toBe("art-1");

		const deck = JSON.parse(JSON.stringify(DECK).replace("ART", id!));
		const full = await replay({
			text: prompt,
			canSeeUserImages: true,
			script: [call("g1", "generate_image", { prompt: "minimalismo japonês", aspect_ratio: "16:9" }), call("f1", "create_file", deck)],
		});
		const created = full.results.find((r) => r.name === "create_file")!;
		expect(created.ok).toBe(true);
		expect(full.files).toHaveLength(1);
		expect(full.files[0]).toMatchObject({ filename: "pitch-japones.pptx", format: "pptx" });
		// conferência visual automática: páginas da sandbox voltam como visão no passo seguinte
		expect(full.runPython).toHaveBeenCalledTimes(1);
		expect(created.summary).toMatch(/Visual check: 1 slide image is attached/);
		expect(full.requests.some((r) => r.vision >= 1)).toBe(true);
		// o arquivo guardado tem a foto de fundo com véu e o layout livre editável
		const saved = [...store.values()].find((row) => row.kind === "file")!;
		expect(saved.userId).toBe("user-a");
		const { slide, mediaNames } = await openPptx(saved.bytes);
		expect(await slide(0)).toContain("<p:bg>");
		expect(await slide(0)).toContain('<a:alpha val="45000"/>');
		expect(await slide(1)).toContain("O produtor perde 3 dias por safra em planilhas");
		expect(await slide(1)).toContain('prst="roundRect"');
		expect(mediaNames.length).toBeGreaterThanOrEqual(2);
	});

	it("imagem de outro usuário no fundo não vira slide: o erro volta ao modelo e nada é criado", async () => {
		store.clear();
		const { results, files } = await replay({
			text: "Faz uma apresentação com essa capa",
			script: [call("f1", "create_file", { ...DECK, slides: [{ layout: "title", title: "Capa", background: { image: "art-de-outro-usuario" } }] })],
		});
		const created = results.find((r) => r.name === "create_file")!;
		expect(created.ok).toBe(false);
		expect(created.summary).toMatch(/not found in this conversation/);
		expect(files).toHaveLength(0);
	});

	it("sem sandbox o deck sai igual e o resultado diz que a conferência visual não foi feita", async () => {
		const { results, files } = await replay({
			text: "Faz uma apresentação curta de 2 slides",
			canSeeUserImages: true,
			withRunner: false,
			script: [call("f1", "create_file", { filename: "curta.pptx", slides: [{ layout: "title", title: "Curta" }, { layout: "bullets", title: "Itens", bullets: ["a"] }] })],
		});
		expect(files).toHaveLength(1);
		const created = results.find((r) => r.name === "create_file")!;
		expect(created.ok).toBe(true);
		expect(created.summary).toMatch(/Visual check not done/);
	});
});
