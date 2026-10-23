import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { insertCardAfterCurrentTurn, type ComputerUseEvent, type PageSpec } from "@workspace/shared";
import { applyPageEvent, dedupeCards, reconcilePersistedThread } from "./thread-merge";

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

test("cartão Executou código ao vivo e o gravado (mesmo callId) viram um só, com o gravado vencendo", () => {
	const live: Message[] = [user("db-u1", "faz o gráfico"), { id: "code-run-call-1", kind: "code-run", callId: "call-1", code: "print(1)", status: "ok", output: "1" }];
	const persisted: Message[] = [user("db-u1", "faz o gráfico"), { id: "db-cr", kind: "code-run", callId: "call-1", code: "print(1)", status: "ok", output: "1", durationMs: 800 }];
	assert.deepEqual(reconcilePersistedThread(persisted, live).map((message) => message.id), ["db-u1", "db-cr"]);
});

test("gráfico ao vivo e o gravado (mesmo chartId) não duplicam; o cartão gravado reaparece após recarregar", () => {
	const spec = { type: "bar", x: "a", series: [{ key: "v", label: "v" }], data: [{ a: "x", v: 1 }], xKind: "category" } as const;
	const chart = (id: string): Message => ({ id, kind: "chart", chartId: "call-1:g.chart.json", spec: spec as never });
	const live: Message[] = [user("db-u1", "gráfico"), chart("chart-call-1:g.chart.json")];
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "gráfico"), chart("db-ch")], live).map((message) => message.id), ["db-u1", "db-ch"]);
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "gráfico"), chart("db-ch")], [user("db-u1", "gráfico")]).map((message) => message.kind), ["user", "chart"]);
	assert.equal(dedupeCards([chart("a"), chart("b")]).length, 1);
});

test("lista de tarefas: um cartão por run; o ao vivo e o gravado colapsam e o gravado reaparece após recarregar", () => {
	const list = (id: string, runId = "run-1"): Message => ({ id, kind: "task-list", runId, items: [{ content: "a", status: "in_progress" }] });
	const live: Message[] = [user("db-u1", "faça"), list("task-list-run-1")];
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "faça"), list("db-tl")], live).map((message) => message.id), ["db-u1", "db-tl"]);
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "faça"), list("db-tl")], [user("db-u1", "faça")]).map((message) => message.kind), ["user", "task-list"]);
	assert.equal(dedupeCards([list("a"), list("b")]).length, 1);
	assert.equal(dedupeCards([list("a"), list("b", "run-2")]).length, 2);
});

test("conversa compactada: o cartão ao vivo (id do servidor) e o gravado viram um só e reaparecem após recarregar", () => {
	const card = (id: string): Message => ({ id, kind: "compaction", before: 48_200, after: 6_100, summary: "Resumo." });
	const live: Message[] = [user("db-u1", "faça"), card("db-compact")];
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "faça"), card("db-compact")], live).map((message) => message.id), ["db-u1", "db-compact"]);
	assert.deepEqual(reconcilePersistedThread([user("db-u1", "faça"), card("db-compact")], [user("db-u1", "faça")]).map((message) => message.kind), ["user", "compaction"]);
	assert.equal(dedupeCards([card("db-compact"), card("db-compact")]).length, 1);
	assert.equal(dedupeCards([card("a"), card("b")]).length, 2);
});

const pageSpec = (title: string): PageSpec => ({ v: 2, title, root: { id: "root", type: "stack", props: {}, children: [{ id: "h", type: "heading", props: { text: title } }] } });
const pageCard = (id: string, revision: number, pageId = "page-1", title = `v${revision}`): Message => ({ id, kind: "page", pageId, revision, title, action: revision > 1 ? "updated" : "created", spec: pageSpec(title), sourceCount: 0 });
const pageEvent = (revision: number, pageId = "page-1"): Extract<ComputerUseEvent, { type: "page" }> => ({ type: "page", action: revision > 1 ? "updated" : "created", pageId, revision, title: `v${revision}`, spec: pageSpec(`v${revision}`), sourceCount: 0 });
const insertLive = (previous: Message[]) => (message: Message) => insertCardAfterCurrentTurn(previous, message);
const pageRevisions = (messages: Message[]) => messages.filter((m) => m.kind === "page").map((m) => `${m.id}@${(m as { revision: number }).revision}`);

test("página: o evento ao vivo entra depois do turno e o mesmo pageId atualiza no lugar (revisão++), sem nova mensagem", () => {
	const first = applyPageEvent([user("db-u1", "monta o forecast")], pageEvent(1), insertLive([user("db-u1", "monta o forecast")]));
	assert.deepEqual(kinds(first), ["user", "page"]);
	const withReply: Message[] = [...first, { id: "as-1", kind: "assistant", text: "Pronto." } as Message];
	const updated = applyPageEvent(withReply, pageEvent(2), insertLive(withReply));
	assert.deepEqual(kinds(updated), ["user", "page", "assistant"]);
	assert.deepEqual(pageRevisions(updated), ["page-live-page-1@2"]);
	// Evento atrasado (revisão menor) não desfaz a mais nova.
	assert.equal(applyPageEvent(updated, pageEvent(1), insertLive(updated)), updated);
	// Outra página é outro cartão.
	assert.equal(applyPageEvent(updated, pageEvent(1, "page-2"), insertLive(updated)).filter((m) => m.kind === "page").length, 2);
});

test("página: o cartão gravado segura a posição e a revisão mais nova vence (ao vivo × gravado)", () => {
	assert.deepEqual(pageRevisions(dedupeCards([user("u1"), pageCard("db-pg", 2), pageCard("page-live-page-1", 3)])), ["db-pg@3"]);
	assert.deepEqual(pageRevisions(dedupeCards([user("u1"), pageCard("db-pg", 3), pageCard("page-live-page-1", 2)])), ["db-pg@3"]);
	// Páginas diferentes não se colapsam.
	assert.equal(dedupeCards([pageCard("a", 1, "p1"), pageCard("b", 1, "p2")]).length, 2);
});

test("página ao vivo e a gravada não duplicam ao reconciliar; a gravada reaparece após recarregar", () => {
	const live: Message[] = [user("db-u1", "forecast"), pageCard("page-live-page-1", 1)];
	const persisted: Message[] = [user("db-u1", "forecast"), pageCard("db-pg", 1)];
	assert.deepEqual(reconcilePersistedThread(persisted, live).map((message) => message.id), ["db-u1", "db-pg"]);
	assert.deepEqual(kinds(reconcilePersistedThread(persisted, [user("db-u1", "forecast")])), ["user", "page"]);
	// Atualização ao vivo ainda não gravada: um cartão só, com a revisão nova.
	const result = reconcilePersistedThread(persisted, [user("db-u1", "forecast"), pageCard("page-live-page-1", 2)]);
	assert.deepEqual(pageRevisions(result), ["db-pg@2"]);
});

test("rotina criada ao vivo e a gravada viram um cartão só, mesmo com fala no meio", () => {
	const liveRoutine: Message = { id: "routine-run1-created-r1", kind: "routine", action: "created", routineId: "r1", title: "Resumo semanal", triggerType: "cron", detail: "A cada segunda-feira às 9:00", hookSecret: "s" };
	const persistedRoutine: Message = { id: "db-routine", kind: "routine", action: "created", routineId: "r1", title: "Resumo semanal", detail: "A cada segunda-feira às 9:00" };
	const narration = "Vou montar a lista de tarefas da semana agora.";
	const live: Message[] = [user("db-u1", "faz toda segunda"), liveRoutine, { id: "cu-1", kind: "assistant", text: narration }];
	const persisted: Message[] = [user("db-u1", "faz toda segunda"), persistedRoutine, { id: "db-a1", kind: "assistant", text: narration }];
	const result = reconcilePersistedThread(persisted, live);
	assert.equal(result.filter((message) => message.kind === "routine").length, 1);
	assert.deepEqual(result.map((message) => message.id), ["db-u1", "db-routine", "db-a1"]);
});

test("cartão de arquivo ao vivo e o gravado do mesmo artifact viram um só", () => {
	const file = (id: string): Message => ({ id, kind: "file", artifactId: "art-1", filename: "a.pdf", mime: "application/pdf", size: 10, origin: "user" });
	const live: Message[] = [user("db-u1", "gera"), file("file-live"), { id: "cu-1", kind: "assistant", text: "Segue o arquivo gerado agora." }];
	const persisted: Message[] = [user("db-u1", "gera"), file("db-file"), { id: "db-a1", kind: "assistant", text: "Segue o arquivo gerado agora." }];
	const result = reconcilePersistedThread(persisted, live);
	assert.equal(result.filter((message) => message.kind === "file").length, 1);
});

test("dedupeCards: rotina criada ao vivo e gravada não vizinhas colapsam no gravado", () => {
	const live: Message = { id: "routine-run1-created-r1", kind: "routine", action: "created", routineId: "r1", title: "R", triggerType: "once" };
	const saved: Message = { id: "db-routine", kind: "routine", action: "created", routineId: "r1", title: "R" };
	const result = dedupeCards([user("u"), saved, { id: "cu-1", kind: "assistant", text: "Vou montar a lista." }, live]);
	assert.deepEqual(result.map((message) => message.id), ["u", "db-routine", "cu-1"]);
});
