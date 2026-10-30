import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { HistoryImageGroup } from "@workspace/shared";
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
const historyGroups: HistoryImageGroup[] = [{ userText: "olha essa tela", items: [{ artifactId: "old-img", name: "old.png" }], missing: [] }];

type Reply = { content: string; finishReason?: string };

async function replay(input: {
	loadUserImage?: (id: string, options?: { retryTransient?: boolean }) => Promise<string | null>;
	describeUserImage?: (id: string, options?: { retryTransient?: boolean }) => Promise<{ description: string | null; loadFailed?: boolean }>;
	canSeeUserImages?: boolean;
	language?: "pt-BR" | "en-US" | "es-ES";
	current?: boolean;
	history?: boolean;
	replies?: Reply[];
	text?: string;
}) {
	const transports: CompleteChatWithToolsParams[] = [];
	const deltas: string[] = [];
	const replies = input.replies ?? [{ content: "Pode reenviar?" }];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "vision/model", apiKey: "test", runId: "run-image-missing", userId: "user-a",
		origin: "chat",
		language: input.language ?? "pt-BR",
		messages: input.history
			? [{ role: "user", content: "olha essa tela" }, { role: "assistant", content: "vi" }, { role: "user", content: input.text ?? "bom dia" }]
			: [{ role: "user", content: input.text ?? "o que tem nessas imagens?" }],
		...(input.current === false ? {} : { userImageArtifactIds: ["image-a"] }),
		...(input.history ? { historyImages: historyGroups } : {}),
		canSeeUserImages: input.canSeeUserImages ?? true,
		loadUserImage: input.loadUserImage,
		describeUserImage: input.describeUserImage,
		sandboxEnabled: false,
		onEvent: (event) => { if (event.type === "assistant_delta") deltas.push(event.delta); },
		streamChat: async (params) => {
			transports.push(params);
			const reply = replies[Math.min(transports.length - 1, replies.length - 1)]!;
			return { model: "vision/model", message: { role: "assistant", content: reply.content }, ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) } as CompleteChatWithToolsResult;
		},
	});
	return { result, transports, deltas, sent: (index = 0) => JSON.stringify(transports[index]?.messages) };
}

describe("imagem anexada que não carrega", () => {
	it("avisa o usuário uma vez, pede retry transitório só para o anexo atual e dá nota honesta ao modelo", async () => {
		const loadUserImage = vi.fn(async () => null);
		const { result, transports, deltas, sent } = await replay({ loadUserImage, replies: [{ content: "Vejo", finishReason: "length" }, { content: "Pode reenviar?" }] });
		expect(transports.length).toBe(2);
		// O runtime lê uma vez por imagem (o retry transitório é do loader) e não tenta de novo no 2º passo.
		expect(loadUserImage).toHaveBeenCalledTimes(1);
		expect(loadUserImage).toHaveBeenCalledWith("image-a", { retryTransient: true });
		for (const index of [0, 1]) {
			expect(sent(index)).toContain("could not be loaded");
			expect(sent(index)).toContain("already told the user");
			expect(sent(index)).toContain("do not ask again");
			expect(sent(index)).not.toContain("image_url");
		}
		expect(deltas.join("").split(PT_NOTE).length - 1).toBe(1);
		expect(result.text).toContain(PT_NOTE);
	});

	it("o aviso sai no idioma do bot", async () => {
		const { deltas } = await replay({ loadUserImage: async () => null, language: "en-US" });
		expect(deltas.join("")).toContain("I couldn't load the image you sent. Can you send it again?");
	});

	it("leitura que funciona não avisa nada", async () => {
		const { result, sent, deltas } = await replay({ loadUserImage: async () => "data:image/png;base64,dGVzdA==" });
		expect(sent()).toContain("image_url");
		expect(deltas.join("")).not.toContain("Não consegui carregar");
		expect(result.text).not.toContain("Não consegui carregar");
	});

	it("imagem de turno antigo que sumiu: sem aviso, sem retry transitório, nota só de histórico e lida uma vez", async () => {
		const loadUserImage = vi.fn(async (id: string) => (id === "old-img" ? null : "data:image/png;base64,dGVzdA=="));
		const { result, deltas, sent } = await replay({ loadUserImage, history: true, current: false, replies: [{ content: "Bom dia!" }] });
		expect(loadUserImage).toHaveBeenCalledWith("old-img", { retryTransient: false });
		expect(deltas.join("")).not.toContain("Não consegui carregar");
		expect(result.text).toBe("Bom dia!");
		expect(sent()).toContain("attached earlier");
		expect(sent()).not.toContain("already told");
	});

	it("modelo sem visão: falha de leitura do apoio também avisa e não diz que o modelo não enxerga", async () => {
		const describeUserImage = vi.fn(async () => ({ description: null, loadFailed: true }));
		const { result, sent } = await replay({ canSeeUserImages: false, describeUserImage });
		expect(describeUserImage).toHaveBeenCalledWith("image-a", { retryTransient: true });
		expect(sent()).toContain("could not be loaded");
		expect(sent()).not.toContain("this model cannot see images");
		expect(result.text).toContain(PT_NOTE);
	});

	it("modelo sem visão e sem apoio configurado continua dizendo que não enxerga (sem aviso de falha)", async () => {
		const { result, sent } = await replay({ canSeeUserImages: false, describeUserImage: async () => ({ description: null }) });
		expect(sent()).toContain("this model cannot see images");
		expect(result.text).not.toContain("Não consegui carregar");
	});
});
