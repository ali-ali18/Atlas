import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { dedupeCards, reconcilePersistedThread } from "@/lib/thread-merge";
import { addLiveDevSessionCard, insertDevSessionCards } from "./cards";

const at = (minute: number, second = 0) => `2026-10-14T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const user = (id: string, minute: number, text = id): Message => ({ id, kind: "user", text, createdAt: at(minute) });
const assistant = (id: string, minute: number, second = 30): Message => ({ id, kind: "assistant", text: id, createdAt: at(minute, second) });
const approval = (id: string, minute: number): Message => ({
	id,
	kind: "confirm",
	title: "Executar este comando?",
	status: "pending",
	confirmId: id,
	devApproval: { kind: "command", command: "git log", cwd: "/workspace" },
	createdAt: at(minute, 10),
} as Message);
const ids = (messages: Message[]) => messages.map((m) => m.id);
const sessionCards = (messages: Message[]) => messages.filter((m) => m.kind === "devsession");

test("histórico: cartão da sessão fica no fim do turno que a iniciou, abaixo do texto e antes do 'confirmado'", () => {
	const persisted: Message[] = [
		user("u1", 0),
		approval("cf-1", 0),
		assistant("a1", 1),
		assistant("a2", 1, 40),
		user("u2", 2, "confirmado: Executar este comando?"),
		assistant("a3", 3),
	];
	const result = insertDevSessionCards(persisted, [{ id: "s1", startedAt: at(0, 5) }]);
	assert.deepEqual(ids(result), ["u1", "a1", "a2", "devsession-s1", "cf-1", "u2", "a3"]);
});

test("ao vivo + sync + hidratação da mesma sessão deixam um cartão só", () => {
	let thread: Message[] = [user("u1", 0), assistant("a1", 0, 20)];
	thread = addLiveDevSessionCard(thread, "s1", Date.parse(at(0, 25)));
	thread = addLiveDevSessionCard(thread, "s1", Date.parse(at(0, 26)));
	thread = insertDevSessionCards(thread, [{ id: "s1", startedAt: at(0, 5) }]);
	thread = insertDevSessionCards(thread, [{ id: "s1", startedAt: at(0, 5) }]);
	assert.equal(sessionCards(thread).length, 1);
	assert.deepEqual(ids(thread), ["u1", "a1", "devsession-s1"]);
});

test("cartões de ids diferentes para a mesma sessão colapsam em um", () => {
	const thread: Message[] = [user("u1", 0), { id: "x", kind: "devsession", sessionId: "s1" }, assistant("a1", 1), { id: "y", kind: "devsession", sessionId: "s1" }];
	assert.equal(sessionCards(dedupeCards(thread)).length, 1);
});

test("cartão ao vivo não vai para o fim da conversa quando o histórico chega", () => {
	const live: Message[] = [
		user("msg-1", 0),
		{ id: "devsession-s1", kind: "devsession", sessionId: "s1", anchorAt: at(0, 5) },
		{ id: "cu-1", kind: "assistant", text: "" },
	];
	const persisted: Message[] = [user("u0", 0, "msg-1"), assistant("a1", 1), user("u2", 3, "outra pergunta"), assistant("a2", 4)];
	const result = reconcilePersistedThread(persisted, live);
	assert.deepEqual(ids(result), ["u0", "a1", "devsession-s1", "u2", "a2"]);
});

test("sequência completa: ao vivo, recarga do histórico e sync mantêm uma posição só", () => {
	let thread: Message[] = [user("u1", 0)];
	thread = addLiveDevSessionCard(thread, "s1", Date.parse(at(0, 5)));
	thread = dedupeCards([...thread, assistant("cu-1", 0, 20), approval("cf-1", 0)]);
	assert.deepEqual(ids(thread), ["u1", "cu-1", "devsession-s1", "cf-1"]);
	const persisted: Message[] = [user("u1", 0), assistant("a1", 1), user("u2", 2, "confirmado: Executar este comando?")];
	const reconciled = reconcilePersistedThread(persisted, thread);
	assert.equal(sessionCards(reconciled).length, 1);
	assert.deepEqual(ids(insertDevSessionCards(reconciled, [{ id: "s1", startedAt: at(0, 5) }])), ids(reconciled));
	const cardIndex = reconciled.findIndex((m) => m.kind === "devsession");
	assert.ok(cardIndex < reconciled.findIndex((m) => m.id === "u2"));
});

test("cartão de aprovação fica abaixo do texto do mesmo turno", () => {
	const thread = dedupeCards([user("u1", 0), approval("cf-1", 0), assistant("a1", 1), user("u2", 2)]);
	assert.deepEqual(ids(thread), ["u1", "a1", "cf-1", "u2"]);
});
