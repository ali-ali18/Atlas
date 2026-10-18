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

const answer: CompleteChatWithToolsResult = { model: "vision/model", message: { role: "assistant", content: "ok" } };

// Turno 1 teve 3 telas; o turno 2 ("igual ao da imagem?") não traz anexo novo.
const messages = [
	{ role: "user" as const, content: "olha essas telas" },
	{ role: "assistant" as const, content: "vi as telas" },
	{ role: "user" as const, content: "igual ao da imagem?" },
];
const history: HistoryImageGroup[] = [
	{ userText: "olha essas telas", items: ["a", "b", "c"].map((id) => ({ artifactId: id, name: `${id}.png` })), missing: [] },
];

async function turnTwo(input: { canSeeUserImages: boolean; groups?: HistoryImageGroup[]; describe?: boolean }) {
	let transport: CompleteChatWithToolsParams | undefined;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "vision/model", apiKey: "test", runId: "run-history", userId: "user-a",
		origin: "chat",
		messages,
		historyImages: input.groups ?? history,
		canSeeUserImages: input.canSeeUserImages,
		loadUserImage: async (id) => `data:image/png;base64,${Buffer.from(`img-${id}`).toString("base64")}`,
		describeUserImage: input.describe ? async (id) => ({ description: `desc ${id}` }) : undefined,
		sandboxEnabled: false,
		onEvent: () => undefined,
		streamChat: async (params) => { transport = params; return answer; },
	});
	return JSON.stringify(transport?.messages);
}

describe("imagens de turnos anteriores no histórico", () => {
	it("replay: turno 2 sem anexo ainda leva as imagens do turno 1", async () => {
		const sent = await turnTwo({ canSeeUserImages: true });
		for (const id of ["a", "b", "c"]) expect(sent).toContain(Buffer.from(`img-${id}`).toString("base64"));
	});

	it("sem visão usa a descrição do apoio, nunca descarta em silêncio", async () => {
		const sent = await turnTwo({ canSeeUserImages: false, describe: true });
		expect(sent).toContain("desc a");
		expect(sent).not.toContain("image_url");
	});

	it("sem visão e sem apoio deixa o marcador de texto", async () => {
		const sent = await turnTwo({ canSeeUserImages: false });
		expect(sent).toContain("cannot see images");
	});

	it("imagem de outro dono nunca é anexada e o modelo recebe a linha neutra", async () => {
		// O db já move ids que não são do dono para `missing`; o runtime só anexa `items`.
		const sent = await turnTwo({ canSeeUserImages: true, groups: [{ userText: "olha essas telas", items: [], missing: ["alheia.png"] }] });
		expect(sent).not.toContain("image_url");
		expect(sent).toContain("[An earlier message included 1 user image(s) (alheia.png); they are not attached now.]");
	});
});
