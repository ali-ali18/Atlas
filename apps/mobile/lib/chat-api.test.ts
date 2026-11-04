import { describe, expect, it } from "vitest";
import { ChatApiError, COMPACT_FAILED_TEXT, compactConversation, compactErrorText, isModelRejection, MODEL_UNAVAILABLE_TEXT, ModelUnavailableError, sendErrorText, clearReaction, createRun, createRunInput, markConversationRead, markConversationUnread, setReaction } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import { runModelFields } from "./model-choice";

type Call = { path: string; method: string | undefined; body: unknown };

function fake(status = 200, payload: unknown = { runId: "r1", status: "queued" }) {
	const calls: Call[] = [];
	const apiFetch: ApiFetch = async (path, init) => {
		calls.push({ path, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		return new Response(JSON.stringify(payload), { status });
	};
	return { apiFetch, calls };
}

describe("createRun e createRunInput: replyToMessageId", () => {
	const base = { content: "oi", conversationId: "c1", botId: "b1" };
	it("sem citação o corpo é o de sempre (sem a chave)", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { ...base, clientKey: "k1" });
		expect(calls[0]!.body).toEqual({ messages: [{ role: "user", content: "oi" }], conversationId: "c1", botId: "b1", clientKey: "k1" });
		await createRunInput(apiFetch, "r1", "oi", "k2");
		expect(calls[1]!.body).toEqual({ content: "oi", mode: "join", clientKey: "k2" });
	});
	it("com citação, o id vai no corpo dos dois", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { ...base, clientKey: "k1", replyToMessageId: "m9" });
		expect(calls[0]!.body).toMatchObject({ replyToMessageId: "m9" });
		await createRunInput(apiFetch, "r1", "oi", "k2", "m9");
		expect(calls[1]!.body).toEqual({ content: "oi", mode: "join", clientKey: "k2", replyToMessageId: "m9" });
	});
});

describe("createRun: modelo da escolha do usuário", () => {
	const base = { content: "oi", conversationId: "c1", botId: "b1", clientKey: "k1" };
	it("bot com modelo fixo e sem escolha: NÃO manda modelAuto (a API respeitaria o modelo do bot)", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { ...base, model: runModelFields(null) });
		expect(calls[0]!.body).not.toHaveProperty("modelAuto");
		expect(calls[0]!.body).not.toHaveProperty("model");
		expect(calls[0]!.body).not.toHaveProperty("reasoningEffort");
	});
	it("Automático: modelAuto true e nenhum modelo", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { ...base, model: runModelFields({ mode: "auto" }) });
		expect(calls[0]!.body).toMatchObject({ modelAuto: true });
		expect(calls[0]!.body).not.toHaveProperty("model");
	});
	it("modelo escolhido: model e reasoningEffort, sem modelAuto", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { ...base, model: runModelFields({ mode: "model", model: "anthropic/claude-sonnet-5.5", effort: "high" }) });
		expect(calls[0]!.body).toEqual({ messages: [{ role: "user", content: "oi" }], conversationId: "c1", botId: "b1", model: "anthropic/claude-sonnet-5.5", reasoningEffort: "high", clientKey: "k1" });
	});
});

describe("reação e não lida", () => {
	it("PUT com o emoji, DELETE sem corpo e POST do não lido, com o id escapado", async () => {
		const { apiFetch, calls } = fake(200, {});
		await setReaction(apiFetch, "m 1", "🔥");
		await clearReaction(apiFetch, "m 1");
		await markConversationUnread(apiFetch, "c/1");
		expect(calls).toEqual([
			{ path: "/v1/messages/m%201/reaction", method: "PUT", body: { emoji: "🔥" } },
			{ path: "/v1/messages/m%201/reaction", method: "DELETE", body: undefined },
			{ path: "/v1/conversations/c%2F1/unread", method: "POST", body: undefined },
		]);
	});
	it("falha lança com o status (nada de sucesso falso)", async () => {
		const { apiFetch } = fake(404, { error: "Message not found" });
		await expect(setReaction(apiFetch, "m1", "🔥")).rejects.toMatchObject({ status: 404 });
		await expect(markConversationUnread(apiFetch, "c1")).rejects.toBeInstanceOf(ChatApiError);
	});
});

describe("markConversationRead", () => {
	it("manda o id da última mensagem para a rota de leitura", async () => {
		const { apiFetch, calls } = fake(200, {});
		await markConversationRead(apiFetch, "c/1", "m9");
		expect(calls).toEqual([{ path: "/v1/conversations/c%2F1/read", method: "POST", body: { upToMessageId: "m9" } }]);
	});
	it("mensagem desconhecida (404) cai em 'até agora', como no web", async () => {
		const calls: Call[] = [];
		const apiFetch: ApiFetch = async (path, init) => {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ path, method: init?.method, body });
			return new Response(JSON.stringify({}), { status: body?.upToMessageId ? 404 : 200 });
		};
		await markConversationRead(apiFetch, "c1", "m9");
		expect(calls.map((call) => call.body)).toEqual([{ upToMessageId: "m9" }, {}]);
	});
});

describe("isModelRejection: o servidor recusou o modelo enviado", () => {
	it("400/404/409 com motivo de modelo ou de provedor", () => {
		expect(isModelRejection(new ChatApiError("Modelo ChatGPT indisponível nesta conta", 400))).toBe(true);
		expect(isModelRejection(new ChatApiError("Referência de modelo inválida", 400))).toBe(true);
		expect(isModelRejection(new ChatApiError("Conecte o ChatGPT em Configurações → Provedores", 400))).toBe(true);
		expect(isModelRejection(new ChatApiError("Ative o plano ChatGPT em Configurações → Provedores para usar este modelo", 400))).toBe(true);
	});
	it("conversa ocupada, catálogo fora do ar, 5xx, 401 e rede não contam", () => {
		expect(isModelRejection(new ChatApiError("A conversa já tem uma tarefa em andamento", 409))).toBe(false);
		expect(isModelRejection(new ChatApiError("Catálogo ChatGPT indisponível. Tente novamente antes de iniciar a tarefa.", 409))).toBe(false);
		expect(isModelRejection(new ChatApiError("model", 500))).toBe(false);
		expect(isModelRejection(new ChatApiError("model", 401))).toBe(false);
		expect(isModelRejection(new ChatApiError("Não encontrado", 404))).toBe(false);
		expect(isModelRejection(new Error("model"))).toBe(false);
	});
	it("o aviso para o usuário é amigável", () => {
		expect(sendErrorText(new ModelUnavailableError(400))).toBe(MODEL_UNAVAILABLE_TEXT);
		expect(MODEL_UNAVAILABLE_TEXT).toContain("voltei ao modelo do bot");
	});
});

describe("compactConversation (/compact)", () => {
	it("POST /v1/conversations/:id/compact com o foco no corpo, sem foco corpo vazio", async () => {
		const { apiFetch, calls } = fake(200, { status: "noop", reason: "too_small", message: "curta" });
		await compactConversation(apiFetch, "c 1");
		await compactConversation(apiFetch, "c1", "decisões");
		expect(calls[0]).toEqual({ path: "/v1/conversations/c%201/compact", method: "POST", body: {} });
		expect(calls[1]!.body).toEqual({ focus: "decisões" });
	});
	it("o erro do servidor (409, 503) aparece como veio; 502 do proxy e rede viram o aviso amigável", async () => {
		const busy = await compactConversation(fake(409, { error: "Há uma execução em andamento." }).apiFetch, "c1").catch((error) => error);
		expect(compactErrorText(busy)).toBe("Há uma execução em andamento.");
		const proxy = await compactConversation(async () => new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" }), "c1").catch((error) => error);
		expect(compactErrorText(proxy)).toBe(COMPACT_FAILED_TEXT);
		expect(compactErrorText(new TypeError("Network request failed"))).toBe(COMPACT_FAILED_TEXT);
		expect(compactErrorText(new ChatApiError("x", 401))).toBe("Sua sessão expirou. Entre de novo.");
	});
});

describe("anexos no corpo", () => {
	it("createRun manda attachments no topo; sem anexo a chave não existe", async () => {
		const { apiFetch, calls } = fake();
		await createRun(apiFetch, { content: "", conversationId: "c1", botId: "b1", attachments: [{ artifactId: "a1" }, { artifactId: "f1" }] });
		expect(calls[0]!.body).toMatchObject({ attachments: [{ artifactId: "a1" }, { artifactId: "f1" }] });
		await createRun(apiFetch, { content: "oi", conversationId: "c1", botId: "b1", attachments: [] });
		expect(calls[1]!.body).not.toHaveProperty("attachments");
	});
	it("createRunInput também leva os anexos", async () => {
		const { apiFetch, calls } = fake();
		await createRunInput(apiFetch, "r1", "oi", "k", undefined, [{ artifactId: "a1" }]);
		expect(calls[0]!.body).toEqual({ content: "oi", mode: "join", clientKey: "k", attachments: [{ artifactId: "a1" }] });
	});
});
