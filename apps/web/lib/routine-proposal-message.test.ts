import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeConversationCard, type PersistedRoutineProposalCard } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import {
	mergeExternalMessages,
	mergeProposalStatuses,
	proposalView,
	routineProposalMessageFromContent,
	setRoutineProposalState,
} from "./routine-proposal-message";
import { dedupeCards } from "./thread-merge";

const spec = { name: "Resumo da semana", prompt: "Resuma a minha semana em 5 itens", schedule: "0 8 * * 1", timezone: "America/Sao_Paulo" };
const card = (patch: Partial<PersistedRoutineProposalCard> = {}): PersistedRoutineProposalCard => ({
	v: 1,
	kind: "routine-proposal",
	proposalId: "p1",
	mode: "suggest",
	status: "pending",
	spec,
	...patch,
});
const proposal = (id: string, patch: Partial<Extract<Message, { kind: "routine-proposal" }>> = {}): Message => ({
	id,
	kind: "routine-proposal",
	proposalId: `p-${id}`,
	mode: "suggest",
	status: "pending",
	spec,
	...patch,
});

test("card persistido vira mensagem da thread com o id da mensagem do banco", () => {
	const message = routineProposalMessageFromContent("db-1", serializeConversationCard(card({ mode: "auto", routineId: "r1" })));
	assert.deepEqual(message, { id: "db-1", kind: "routine-proposal", proposalId: "p1", mode: "auto", status: "pending", spec, routineId: "r1" });
	assert.equal(routineProposalMessageFromContent("db-1", "{lixo"), null);
	assert.equal(routineProposalMessageFromContent("db-1", JSON.stringify({ v: 1, kind: "confirm" })), null);
});

test("estado do card: aplicando, decidido e erro mexem só nele", () => {
	const thread: Message[] = [{ id: "u", kind: "user", text: "oi" }, proposal("a"), proposal("b")];
	const applying = setRoutineProposalState(thread, "a", "applying");
	assert.equal(applying[1]?.kind === "routine-proposal" && applying[1].isApplying, true);
	assert.equal(applying[2]?.kind === "routine-proposal" && applying[2].isApplying, undefined);
	const done = setRoutineProposalState(applying, "a", { status: "accepted" });
	assert.deepEqual(done[1] && done[1].kind === "routine-proposal" && [done[1].status, done[1].isApplying, done[1].error], ["accepted", false, null]);
	const failed = setRoutineProposalState(applying, "a", { error: "falhou" });
	assert.deepEqual(failed[1] && failed[1].kind === "routine-proposal" && [failed[1].status, failed[1].isApplying, failed[1].error], ["pending", false, "falhou"]);
	assert.equal(done[0], thread[0]);
});

test("textos do Sugerir: pergunta com a agenda, Criar / Agora não, e os estados decididos", () => {
	const pending = proposalView({ mode: "suggest", status: "pending", spec, schedule: "toda segunda às 8h" });
	assert.equal(pending.title, "Quer que eu faça “Resumo da semana” toda segunda às 8h?");
	assert.deepEqual([pending.confirmLabel, pending.cancelLabel, pending.resolved], ["Criar", "Agora não", false]);
	assert.equal(pending.badge.label, "Sugestão");
	const created = proposalView({ mode: "suggest", status: "accepted", spec, schedule: "toda segunda às 8h" });
	assert.deepEqual([created.badge.label, created.resolved, created.note], ["Criada", true, "Roda toda segunda às 8h."]);
	assert.equal(proposalView({ mode: "suggest", status: "declined", spec, schedule: "x" }).badge.label, "Agora não");
});

test("textos do Automático: 'Criei a rotina … — manter?' com Manter / Desfazer", () => {
	const pending = proposalView({ mode: "auto", status: "pending", spec, schedule: "toda segunda às 8h" });
	assert.equal(pending.title, "Criei a rotina “Resumo da semana” — manter?");
	assert.deepEqual([pending.confirmLabel, pending.cancelLabel, pending.resolved], ["Manter", "Desfazer", false]);
	assert.match(pending.description, /^Roda toda segunda às 8h\./);
	assert.equal(proposalView({ mode: "auto", status: "accepted", spec, schedule: "x" }).badge.label, "Mantida");
	const undone = proposalView({ mode: "auto", status: "declined", spec, schedule: "x" });
	assert.deepEqual([undone.badge.label, undone.note, undone.resolved], ["Desfeita", "A rotina foi removida.", true]);
});

test("instrução longa é cortada na descrição", () => {
	const view = proposalView({ mode: "suggest", status: "pending", spec: { name: "n", prompt: "palavra ".repeat(80) }, schedule: "x" });
	assert.ok(view.description.length <= 160 && view.description.endsWith("…"));
});

test("mensagens novas gravadas fora do run entram na posição pelo horário; as conhecidas não duplicam", () => {
	const previous: Message[] = [
		{ id: "a1", kind: "assistant", text: "oi", createdAt: "2026-10-14T10:00:00.000Z" },
		{ id: "a3", kind: "assistant", text: "depois", createdAt: "2026-10-14T12:00:00.000Z" },
	];
	const refreshed: Message[] = [
		{ id: "a1", kind: "assistant", text: "oi", createdAt: "2026-10-14T10:00:00.000Z" },
		{ id: "a2", kind: "assistant", text: "lembrete", createdAt: "2026-10-14T11:00:00.000Z" },
		proposal("p9", { createdAt: "2026-10-14T13:00:00.000Z" }),
		{ id: "u9", kind: "user", text: "ignorado", createdAt: "2026-10-14T13:30:00.000Z" },
	];
	const merged = mergeExternalMessages(previous, refreshed);
	assert.deepEqual(merged.map((m) => m.id), ["a1", "a2", "a3", "p9"]);
	assert.equal(mergeExternalMessages(merged, refreshed), merged);
});

test("status decidido em outra aba chega ao card, exceto enquanto este clique está em andamento", () => {
	const previous: Message[] = [proposal("a"), proposal("b", { isApplying: true })];
	const refreshed: Message[] = [proposal("a", { status: "accepted", routineId: "r1" }), proposal("b", { status: "declined" })];
	const merged = mergeProposalStatuses(previous, refreshed);
	assert.deepEqual(merged.map((m) => (m.kind === "routine-proposal" ? [m.status, m.routineId] : null)), [["accepted", "r1"], ["pending", undefined]]);
});

test("o mesmo cartão (id ao vivo e do banco) aparece uma vez", () => {
	const twice = dedupeCards([proposal("a", { proposalId: "same" }), proposal("a", { proposalId: "same" })]);
	assert.equal(twice.filter((m) => m.kind === "routine-proposal").length, 1);
});
