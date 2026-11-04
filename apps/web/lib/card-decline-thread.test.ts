import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { buildSessionMessage } from "@/hooks/use-atlas-chat";
import { approvalMarkerFor, isHiddenProtocolBubble } from "./approval-dock";
import { createTranslator } from "./i18n/translator";
import { reconcilePersistedThread } from "./thread-merge";

/**
 * Pedido do dono (04/11): recusar um cartão é comunicação interna. O clique ("cancela isso") e o registro para o modelo
 * (nota `system`) ficam no histórico, mas a conversa só mostra o selo do cartão: nenhum balão novo.
 */
const row = (id: string, role: string, content: string): SessionMessage => ({ id, conversationId: "c1", role, content, createdAt: "2026-11-04T12:00:00.000Z" }) as unknown as SessionMessage;
const card = JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-toolab-r1", title: "Enviar esta mensagem?", status: "rejected", ownerCard: "approval", outcome: { ok: false, detail: "Agora não" } });

test("recusa: o clique e a nota oculta não viram balão; fica só o marcador do cartão", () => {
	const persisted = [
		row("u1", "user", "Manda o resumo para a Ana"),
		row("cf", "confirm", card),
		row("u2", "user", "cancela isso"),
		row("n1", "system", '[runtime] Owner declined: "Enviar esta mensagem". It was not done.'),
	]
		.map(buildSessionMessage)
		.filter((message): message is Message => message !== null);
	assert.equal(persisted.some((message) => message.id === "n1"), false, "a nota do modelo nunca aparece");
	const live: Message[] = [{ id: "msg-1", kind: "user", text: "cancela isso" }];
	const thread = reconcilePersistedThread(persisted, live).filter((message) => !isHiddenProtocolBubble(message));
	assert.deepEqual(thread.map((message) => message.kind), ["user", "confirm"]);
	assert.equal(thread.some((message) => message.kind === "assistant"), false);
	const confirm = thread.find((message) => message.kind === "confirm")!;
	const marker = approvalMarkerFor(confirm, new Set(), thread, 2, createTranslator("pt-BR"));
	assert.equal(marker?.status === "pending", false);
});

test("prazo vencido e dispensado: o marcador diz como fechou, sem balão", () => {
	const closed = (detail: string) => buildSessionMessage(row("cf", "confirm", JSON.stringify({ v: 1, kind: "confirm", confirmId: "c", title: "Criar um link público do painel?", status: "rejected", ownerCard: "approval", outcome: { ok: false, detail } })))!;
	const pt = createTranslator("pt-BR");
	assert.match(approvalMarkerFor(closed("Tempo esgotado · segui sem isso"), new Set(), [], 0, pt)!.label, /^Tempo esgotado · segui sem isso · Criar um link público/);
	assert.match(approvalMarkerFor(closed("Dispensado"), new Set(), [], 0, pt)!.label, /^Dispensado · /);
});
