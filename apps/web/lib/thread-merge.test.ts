import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { dedupeCards, reconcilePersistedThread } from "./thread-merge";

const MARKER_TEXT = "JEV pediu confirmação; a ação ainda não foi executada.";
const USER_TEXT = "Crie um evento de teste amanhã às 15h";

const user = (id: string, text = USER_TEXT): Message => ({ id, kind: "user", text });
const confirm = (id: string, confirmId = "cf-1"): Message => ({
	id,
	kind: "confirm",
	title: "Google Agenda: executar create_event?",
	status: "pending",
	confirmId,
});
const marker = (id = "jev-run1-call1", text = MARKER_TEXT): Message => ({ id, kind: "jev-status", text });
const kinds = (messages: Message[]) => messages.map((m) => m.kind);

test("card de imagens persiste na ordem e substitui o otimista", () => {
	const item = { artifactId: "img-1", mime: "image/png", width: 300, height: 200 };
	const live: Message[] = [user("msg-1", "foto"), { id: "images-msg-1", kind: "images", source: "user", items: [item] }];
	const persisted: Message[] = [user("db-1", "foto"), { id: "db-img-1", kind: "images", source: "user", items: [item] }];
	const result = reconcilePersistedThread(persisted, live);
	assert.deepEqual(result.map((message) => message.id), ["db-1", "db-img-1"]);
});

test("imagem do assistente via SSE não duplica quando chega o card salvo", () => {
	const item = { artifactId: "screen-1", mime: "image/jpeg", width: 800, height: 600 };
	const live: Message[] = [user("db-u1", "mostre a tela"), { id: "images-run-1-screen-1", kind: "images", source: "assistant", items: [item] }];
	const persisted: Message[] = [user("db-u1", "mostre a tela"), { id: "db-image", kind: "images", source: "assistant", items: [item] }];
	assert.deepEqual(reconcilePersistedThread(persisted, live).map((message) => message.id), ["db-u1", "db-image"]);
});

test("card ao vivo e persistido com o mesmo confirmId viram um só", () => {
	const persisted = [user("db-u1"), marker(), confirm("db-c1")];
	const live = [user("msg-1"), confirm("cf-1"), marker()];
	const result = reconcilePersistedThread(persisted, live);
	assert.deepEqual(kinds(result), ["user", "jev-status", "confirm"]);
	assert.equal(result.find((m) => m.kind === "confirm")?.id, "db-c1");
});

test("mensagem otimista e persistida (texto igual, espaços diferentes) viram uma só", () => {
	const result = reconcilePersistedThread([user("db-u1", `${USER_TEXT}  \n`)], [user("msg-1")]);
	assert.deepEqual(result.map((m) => m.id), ["db-u1"]);
});

test("otimista casa com persistida mesmo sem id conhecido em comum", () => {
	const persisted = [user("db-u0", "oi"), user("db-u1")];
	const live = [user("db-u0", "oi"), user("msg-1")];
	assert.deepEqual(reconcilePersistedThread(persisted, live).map((m) => m.id), ["db-u0", "db-u1"]);
});

test("marcador do Jev e card aparecem uma vez cada", () => {
	const result = dedupeCards([user("u"), marker(), confirm("cf-1"), confirm("db-c1"), marker()]);
	assert.deepEqual(kinds(result), ["user", "jev-status", "confirm"]);
});

test("marcador que chegou depois do card sobe para acima dele", () => {
	const result = dedupeCards([user("u"), confirm("cf-1"), marker()]);
	assert.deepEqual(kinds(result), ["user", "jev-status", "confirm"]);
});

test("marcador já acima do card fica onde está e cards de turnos diferentes não se misturam", () => {
	const turn1 = [user("u1"), marker("jev-a"), confirm("c1", "cf-1")];
	const turn2 = [user("u2"), confirm("c2", "cf-2"), marker("jev-b")];
	const result = dedupeCards([...turn1, ...turn2]);
	assert.deepEqual(result.map((m) => m.id), ["u1", "jev-a", "c1", "u2", "jev-b", "c2"]);
});

test("marcador ao vivo depois do reload persistido continua acima do card", () => {
	const persisted = [user("db-u1"), confirm("db-c1"), marker()];
	const result = reconcilePersistedThread(persisted, [user("msg-1"), confirm("cf-1"), marker()]);
	assert.deepEqual(kinds(result), ["user", "jev-status", "confirm"]);
});

test("F12/B5: card de login repetido (live + salvo) colapsa; done não colapsa com pending", () => {
	const login = (id: string, status: "pending" | "done"): Message => ({
		id,
		kind: "login",
		loginId: "login-run-1",
		site: "bling.com.br",
		url: "https://www.bling.com.br/login",
		status,
	});
	const out = dedupeCards([user("u1"), login("a", "pending"), login("b", "pending")]);
	assert.equal(out.filter((m) => m.kind === "login").length, 1);
	const both = dedupeCards([user("u1"), login("a", "pending"), login("b", "done")]);
	assert.equal(both.filter((m) => m.kind === "login").length, 2);
});

test("marcador de fallback do provedor ao vivo e persistido viram um só e sobrevivem ao recarregar", () => {
	const fallback = (id: string): Message => ({ id, kind: "provider-fallback", text: "OpenCode Go indisponível para este modelo; usando deepseek-v4.1-flash", from: "opencode-go/kimi-k3", to: "deepseek/deepseek-v4.1-flash" });
	const live = [user("msg-1"), fallback("provider-fallback-run1-a-b"), { id: "cu-1", kind: "assistant", text: "resposta" } as Message];
	const persisted = [user("db-u1"), fallback("db-f1"), { id: "db-a1", kind: "assistant", text: "resposta" } as Message];
	const result = reconcilePersistedThread(persisted, live);
	assert.equal(result.filter((m) => m.kind === "provider-fallback").length, 1);
	assert.equal(result.find((m) => m.kind === "provider-fallback")?.id, "db-f1");
	assert.equal(dedupeCards([fallback("a"), fallback("b")]).length, 1);
	// run retomado: mesmo aviso não consecutivo no mesmo turno aparece uma vez; em outro turno, fica
	const assistant = (id: string): Message => ({ id, kind: "assistant", text: "x" } as Message);
	assert.equal(dedupeCards([user("u1"), fallback("a"), assistant("as1"), fallback("b")]).filter((m) => m.kind === "provider-fallback").length, 1);
	assert.equal(dedupeCards([user("u1"), fallback("a"), assistant("as1"), user("u2"), fallback("b")]).filter((m) => m.kind === "provider-fallback").length, 2);
});
