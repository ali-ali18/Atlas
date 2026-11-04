import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { buildSessionMessage } from "@/hooks/use-atlas-chat";
import { isHiddenProtocolBubble } from "./approval-dock";
import { reconcilePersistedThread } from "./thread-merge";

/**
 * Pedido do dono (04/11): recusar um cartão é comunicação interna. O clique ("cancela isso") e o registro para o modelo
 * (role oculto `owner_decision`) ficam no histórico, mas a conversa só mostra o cartão: nenhum balão novo.
 */
const row = (id: string, role: string, content: string): SessionMessage => ({ id, conversationId: "c1", role, content, createdAt: "2026-11-04T12:00:00.000Z" }) as unknown as SessionMessage;
const card = JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-toolab-r1", title: "Enviar esta mensagem?", status: "rejected" });

test("recusa: o clique e a nota oculta não viram balão; fica só o cartão", () => {
	const persisted = [
		row("u1", "user", "Manda o resumo para a Ana"),
		row("cf", "confirm", card),
		row("u2", "user", "cancela isso"),
		row("n1", "owner_decision", 'Owner declined: "Enviar esta mensagem". It was not done.'),
	]
		.map(buildSessionMessage)
		.filter((message): message is Message => message !== null);
	assert.equal(persisted.some((message) => message.id === "n1"), false, "a nota do modelo nunca aparece");
	const live: Message[] = [{ id: "msg-1", kind: "user", text: "cancela isso" }];
	const thread = reconcilePersistedThread(persisted, live).filter((message) => !isHiddenProtocolBubble(message));
	assert.deepEqual(thread.map((message) => message.kind), ["user", "confirm"]);
	assert.equal(thread.some((message) => message.kind === "assistant" || message.kind === "tool"), false);
});
