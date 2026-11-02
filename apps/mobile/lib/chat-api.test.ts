import { describe, expect, it } from "vitest";
import { ChatApiError, clearReaction, createRun, createRunInput, markConversationUnread, setReaction } from "./chat-api";
import type { ApiFetch } from "./home-sync";

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
		expect(calls[0]!.body).toEqual({ messages: [{ role: "user", content: "oi" }], conversationId: "c1", botId: "b1", modelAuto: true, clientKey: "k1" });
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
