import { describe, expect, it, vi } from "vitest";
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

const PT_NOTE = "Não consegui carregar a imagem que você enviou. Pode mandar de novo?";

async function replay(input: { loadUserImage: (id: string) => Promise<string | null>; language?: "pt-BR" | "en-US" | "es-ES"; twoSteps?: boolean }) {
	const transports: CompleteChatWithToolsParams[] = [];
	const deltas: string[] = [];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "vision/model", apiKey: "test", runId: "run-image-missing", userId: "user-a",
		origin: "chat",
		language: input.language ?? "pt-BR",
		messages: [{ role: "user", content: "o que tem nessas imagens?" }],
		userImageArtifactIds: ["image-a"],
		canSeeUserImages: true,
		loadUserImage: input.loadUserImage,
		imageLoadRetryDelayMs: 0,
		sandboxEnabled: false,
		onEvent: (event) => { if (event.type === "assistant_delta") deltas.push(event.delta); },
		streamChat: async (params) => {
			transports.push(params);
			// 1ª resposta cortada força um 2º passo com as mesmas imagens (memo do run).
			if (input.twoSteps && transports.length === 1) return { model: "vision/model", message: { role: "assistant", content: "Vejo" }, finishReason: "length" } as CompleteChatWithToolsResult;
			return { model: "vision/model", message: { role: "assistant", content: "Pode reenviar?" } } as CompleteChatWithToolsResult;
		},
	});
	return { result, transports, deltas };
}

describe("imagem anexada que não carrega", () => {
	it("avisa o usuário no idioma dele, dá ao modelo uma nota curta e tenta de novo só uma vez", async () => {
		const loadUserImage = vi.fn(async () => null);
		const { result, transports, deltas } = await replay({ loadUserImage, twoSteps: true });
		expect(transports.length).toBe(2);
		// Uma tentativa + uma nova (corrida de deploy); o 2º passo não tenta de novo.
		expect(loadUserImage).toHaveBeenCalledTimes(2);
		for (const transport of transports) {
			const sent = JSON.stringify(transport.messages);
			expect(sent).toContain("could not be loaded");
			expect(sent).toContain("do not guess");
			expect(sent).not.toContain("image_url");
		}
		// Aviso aparece uma vez, ao vivo e na resposta gravada.
		expect(deltas.join("")).toContain(PT_NOTE);
		expect(deltas.join("").split(PT_NOTE).length - 1).toBe(1);
		expect(result.text).toContain(PT_NOTE);
	});

	it("o aviso sai no idioma do bot", async () => {
		const { deltas } = await replay({ loadUserImage: async () => null, language: "en-US" });
		expect(deltas.join("")).toContain("I couldn't load the image you sent. Can you send it again?");
	});

	it("a segunda tentativa que funciona não avisa nada (corrida de deploy)", async () => {
		let calls = 0;
		const loadUserImage = vi.fn(async () => (++calls === 1 ? null : "data:image/png;base64,dGVzdA=="));
		const { result, transports, deltas } = await replay({ loadUserImage });
		expect(loadUserImage).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(transports[0]?.messages)).toContain("image_url");
		expect(deltas.join("")).not.toContain("Não consegui carregar");
		expect(result.text).not.toContain("Não consegui carregar");
	});
});
