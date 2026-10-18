import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCompletionRequest, ChatMessage } from "@workspace/shared";
import { prepareMessagesForCompletion } from "./memory.js";

const request: ChatCompletionRequest = {
	messages: [{ role: "user", content: "o que combinamos sobre o prazo?" }],
	conversationId: "conv-a",
};
const hit = { conversationId: "conv-old", role: "user" as const, content: "prazo de entrega é sexta", createdAt: "2026-01-01T00:00:00.000Z" };

function deps(history: ChatMessage[]) {
	const searches: Array<{ query: string; userId?: string }> = [];
	return {
		searches,
		deps: {
			buildMemoryAugmentedMessages: async () => history,
			searchConversationMessages: async (query: string, opts?: { userId?: string }) => {
				searches.push({ query, userId: opts?.userId });
				// Banco fake com dois donos: só devolve o que é do dono pedido.
				return opts?.userId === "user-a" ? [hit] : [{ ...hit, content: "segredo do usuário B" }];
			},
		},
	};
}

const history: ChatMessage[] = [
	{ role: "system", content: "PERFIL" },
	{ role: "user", content: "pergunta antiga" },
	{ role: "assistant", content: "resposta antiga" },
	...request.messages,
];

test("trechos de conversas passadas são buscados com o dono e vão antes do turno, não do histórico", async () => {
	const { deps: d, searches } = deps(history);
	const out = await prepareMessagesForCompletion(request, "user-a", d as never);
	assert.deepEqual(searches, [{ query: request.messages[0]!.content, userId: "user-a" }]);
	assert.equal(out[0]?.content, "PERFIL");
	assert.match(out[out.length - 2]!.content, /prazo de entrega é sexta/);
	assert.equal(out[out.length - 1]?.content, request.messages[0]!.content);
});

test("usuário B não recebe trechos do usuário A (busca sempre escopada pelo dono)", async () => {
	const { deps: d, searches } = deps(history);
	const out = await prepareMessagesForCompletion(request, "user-b", d as never);
	assert.equal(searches[0]?.userId, "user-b");
	assert.ok(!out.some((m) => m.content.includes("prazo de entrega é sexta")));
});

test("sem dono não busca em conversas passadas", async () => {
	const { deps: d, searches } = deps(history);
	const out = await prepareMessagesForCompletion(request, undefined, d as never);
	assert.equal(searches.length, 0);
	assert.deepEqual(out, history);
});
