import { describe, expect, it } from "vitest";
import { ARTIFACT_READ_PAGE_CHARS, STORED_RESULT_NOT_FOUND, readStoredResult, type StoredArtifact } from "./artifact-read.js";

const CONTENT = Array.from({ length: 2_000 }, (_, i) => `entry-${i} value-${i * 7}`).join("\n");

/** Banco em memória com o contrato de dono do `loadArtifactForUser`: só o dono acha. */
function fakeStore() {
	const rows = new Map<string, StoredArtifact & { owner: string; conversationId?: string }>([
		["art-a", { owner: "user-a", kind: "tool_result", runId: "run-1", conversationId: "conv-1", bytes: new TextEncoder().encode(CONTENT) }],
		["art-other-run", { owner: "user-a", kind: "tool_result", runId: "run-2", conversationId: "conv-1", bytes: new TextEncoder().encode("outro run") }],
		["art-file", { owner: "user-a", kind: "file", runId: "run-1", conversationId: "conv-1", bytes: new TextEncoder().encode("arquivo do usuário") }],
		["art-other-conv", { owner: "user-a", kind: "tool_result", runId: "run-3", conversationId: "conv-2", bytes: new TextEncoder().encode("outra conversa") }],
	]);
	const calls: Array<[string, string]> = [];
	const loadCalls: Array<[string, string, string]> = [];
	const load = async (id: string, userId: string) => {
		calls.push([id, userId]);
		const row = rows.get(id);
		return row && row.owner === userId ? row : null;
	};
	const loadFromConversation = async (id: string, userId: string, conversationId: string) => {
		loadCalls.push([id, userId, conversationId]);
		const row = rows.get(id);
		return row && row.owner === userId && row.conversationId === conversationId ? row : null;
	};
	return { load, loadFromConversation, calls, loadCalls };
}

const ctx = () => ({ userId: "user-a", runId: "run-1", conversationId: "conv-1" });

describe("L3: artifact_read de resultado guardado", () => {
	it("lê por páginas e diz onde continuar", async () => {
		const { load } = fakeStore();
		const first = await readStoredResult({ id: "art-a" }, { ...ctx(), load });
		expect(first).toContain(`characters 0-${ARTIFACT_READ_PAGE_CHARS} of ${CONTENT.length}`);
		expect(first).toContain(`offset ${ARTIFACT_READ_PAGE_CHARS}`);
		expect(first).toContain(CONTENT.slice(0, 40));
		const second = await readStoredResult({ id: "art-a", offset: ARTIFACT_READ_PAGE_CHARS, length: 100 }, { ...ctx(), load });
		expect(second).toContain(CONTENT.slice(ARTIFACT_READ_PAGE_CHARS, ARTIFACT_READ_PAGE_CHARS + 100));
		const last = await readStoredResult({ id: "art-a", offset: CONTENT.length - 20 }, { ...ctx(), load });
		expect(last).toContain("End of the stored result");
		expect(await readStoredResult({ id: "art-a", offset: CONTENT.length + 5 }, { ...ctx(), load })).toContain("past the end");
	});

	it("find devolve as ocorrências com a posição, sem caixa, e diz quando não há", async () => {
		const { load } = fakeStore();
		const found = await readStoredResult({ id: "art-a", find: "ENTRY-1500 " }, { ...ctx(), load });
		expect(found).toContain("1 match");
		expect(found).toContain(`@${CONTENT.indexOf("entry-1500 ")}:`);
		expect(found).toContain("entry-1500 value-10500");
		expect(await readStoredResult({ id: "art-a", find: "inexistente" }, { ...ctx(), load })).toContain("no match");
		const many = await readStoredResult({ id: "art-a", find: "entry-" }, { ...ctx(), load });
		expect(many).toContain("6 match");
	});

	it("outro usuário não lê (a resposta é a mesma de id inexistente) e o dono vem do run, não do argumento", async () => {
		const { load, calls } = fakeStore();
		await expect(readStoredResult({ id: "art-a" }, { userId: "user-b", runId: "run-1", load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		await expect(readStoredResult({ id: "nao-existe" }, { ...ctx(), load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		expect(calls[0]).toEqual(["art-a", "user-b"]);
		await expect(readStoredResult({ id: "art-a", userId: "user-a" }, { userId: "user-b", runId: "run-1", load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
	});

	it("resultado de outro run do mesmo dono e artefato de outro tipo também não", async () => {
		const { load } = fakeStore();
		await expect(readStoredResult({ id: "art-other-run" }, { ...ctx(), load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		await expect(readStoredResult({ id: "art-file" }, { ...ctx(), load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
	});

	it("sem dono real ou sem run, nada é lido", async () => {
		const { load, calls } = fakeStore();
		await expect(readStoredResult({ id: "art-a" }, { userId: "default", runId: "run-1", load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		await expect(readStoredResult({ id: "art-a" }, { userId: "user-a", load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		expect(calls).toHaveLength(0);
	});

	it("valida os argumentos antes de tocar no armazenamento", async () => {
		const { load, calls } = fakeStore();
		const bad = [{}, { id: "../etc/passwd" }, { id: "a".repeat(65) }, { id: "art-a", offset: -1 }, { id: "art-a", length: 0 }, { id: "art-a", length: 9_000 }, { id: "art-a", offset: 1.5 }];
		for (const args of bad) {
			await expect(readStoredResult(args, { ...ctx(), load })).rejects.toThrow();
		}
		expect(calls).toHaveLength(0);
	});

	it("aceita prefixo artifact: e o remove antes de validar", async () => {
		const { load, calls } = fakeStore();
		const result = await readStoredResult({ id: "artifact:art-a" }, { ...ctx(), load });
		expect(result).toContain(`artifact:art-a characters 0-${ARTIFACT_READ_PAGE_CHARS} of ${CONTENT.length}`);
		expect(result).toContain(CONTENT.slice(0, 40));
		// O id é normalizado e a busca no armazenamento usa apenas "art-a"
		expect(calls[0]).toEqual(["art-a", "user-a"]);
	});

	it("lê artefato de run anterior na mesma conversa", async () => {
		const { load, loadFromConversation, loadCalls } = fakeStore();
		// art-other-run está em run-2, não em run-1 (ctx tem run-1)
		await expect(readStoredResult({ id: "art-other-run" }, { ...ctx(), load })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		// Mas passando loadFromConversation, consegue ler do run-2 (mesma conversa)
		const result = await readStoredResult({ id: "art-other-run" }, { ...ctx(), load, loadFromConversation });
		expect(result).toContain("characters 0-");
		expect(result).toContain("outro run");
		// loadFromConversation deve ter sido chamado
		expect(loadCalls).toHaveLength(1);
	});

	it("outra conversa não é lida mesmo com loadFromConversation", async () => {
		const { load, loadFromConversation } = fakeStore();
		await expect(readStoredResult({ id: "art-other-conv" }, { ...ctx(), load, loadFromConversation })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
	});

	it("sem conversationId, não tenta carregar de runs anteriores", async () => {
		const { load, loadFromConversation, loadCalls } = fakeStore();
		// Remove conversationId do contexto
		const noConvCtx = { userId: "user-a", runId: "run-1" };
		await expect(readStoredResult({ id: "art-other-run" }, { ...noConvCtx, load, loadFromConversation })).rejects.toThrow(STORED_RESULT_NOT_FOUND);
		// loadFromConversation never called because conversationId is undefined
		expect(loadCalls).toHaveLength(0);
	});
});
