import { describe, expect, it, vi } from "vitest";
import { proposalErrorText, resolveBotProfile, resolveBotProposal } from "./card-api";
import { ChatApiError } from "./chat-api";

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("resolver proposta de agente", () => {
	it("manda só conversa, proposta e decisão, e lê a resposta", async () => {
		const fetch = reply(200, { ok: true, status: "approved", name: "Estoquinho", botId: "bot-9", unchanged: false, warnings: ["O modelo sugerido não está disponível; usei o padrão."] });
		const result = await resolveBotProposal(fetch, { conversationId: "c1", proposalId: "p1", decision: "approved" });
		expect(fetch).toHaveBeenCalledOnce();
		const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(path).toBe("/v1/cards/bot-proposal/resolve");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ conversationId: "c1", proposalId: "p1", decision: "approved" });
		expect(result).toEqual({ status: "approved", name: "Estoquinho", botId: "bot-9", unchanged: false, warnings: ["O modelo sugerido não está disponível; usei o padrão."] });
	});
	it("recusada não traz bot; repetida vem como unchanged", async () => {
		expect(await resolveBotProposal(reply(200, { ok: true, status: "rejected", name: "X", botId: null, unchanged: true }), { conversationId: "c", proposalId: "p", decision: "rejected" })).toEqual({ status: "rejected", name: "X", botId: null, unchanged: true, warnings: [] });
	});
	it("400, 404, 409, 503 e 500 viram ChatApiError com o status; resposta torta vira 502", async () => {
		for (const status of [400, 404, 409, 503, 500]) {
			await expect(resolveBotProposal(reply(status, { error: "ruim" }), { conversationId: "c", proposalId: "p", decision: "approved" })).rejects.toMatchObject({ status, message: "ruim" });
		}
		await expect(resolveBotProposal(reply(200, { ok: true }), { conversationId: "c", proposalId: "p", decision: "approved" })).rejects.toMatchObject({ status: 502 });
	});
	it("falha de rede propaga como erro que não é do servidor", async () => {
		const fetch = vi.fn(async () => Promise.reject(new TypeError("Network request failed")));
		await expect(resolveBotProposal(fetch, { conversationId: "c", proposalId: "p", decision: "approved" })).rejects.toBeInstanceOf(TypeError);
	});
});

describe("resolver proposta de perfil", () => {
	it("manda o corpo do servidor e lê status e campos", async () => {
		const fetch = reply(200, { ok: true, status: "approved", fields: ["name", "description"] });
		expect(await resolveBotProfile(fetch, { conversationId: "c1", proposalId: "pf1", decision: "approved" })).toEqual({ status: "approved", fields: ["name", "description"] });
		const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(path).toBe("/v1/cards/bot-profile/resolve");
		expect(JSON.parse(String(init.body))).toEqual({ conversationId: "c1", proposalId: "pf1", decision: "approved" });
	});
	it("404 (já resolvida) e 503 viram ChatApiError", async () => {
		await expect(resolveBotProfile(reply(404, { error: "Proposal not found or already resolved" }), { conversationId: "c", proposalId: "p", decision: "approved" })).rejects.toMatchObject({ status: 404 });
		await expect(resolveBotProfile(reply(503, { error: "Failed" }), { conversationId: "c", proposalId: "p", decision: "rejected" })).rejects.toMatchObject({ status: 503 });
	});
});

describe("frases de erro", () => {
	it("404, 409, 401, servidor e rede", () => {
		expect(proposalErrorText(new ChatApiError("x", 404), "approved", "bot")).toBe("Esta proposta não existe mais.");
		expect(proposalErrorText(new ChatApiError("x", 409), "approved", "bot")).toBe("Esta proposta já foi recusada.");
		expect(proposalErrorText(new ChatApiError("x", 401), "approved", "bot")).toBe("Sua sessão expirou. Entre de novo.");
		expect(proposalErrorText(new ChatApiError("x", 503), "approved", "bot")).toBe("Não consegui criar o agente. Tente de novo.");
		expect(proposalErrorText(new ChatApiError("x", 500), "approved", "profile")).toBe("Não consegui aplicar agora. Tente de novo.");
		expect(proposalErrorText(new ChatApiError("x", 500), "rejected", "bot")).toBe("Não consegui dispensar agora. Tente de novo.");
		expect(proposalErrorText(new TypeError("Network request failed"), "approved", "bot")).toBe("Sem conexão com o seu servidor. Tente de novo.");
	});
	it("a frase nunca traz texto técnico do servidor", () => {
		expect(proposalErrorText(new ChatApiError("PrismaClientKnownRequestError", 500), "approved", "bot")).not.toMatch(/Prisma/);
	});
});
