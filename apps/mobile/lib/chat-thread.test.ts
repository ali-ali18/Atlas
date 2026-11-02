import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { dedupeKeys, dockedTaskList, mergeTail, messagesPath, oldestCursor, parsePage, persistedAssistantCovers, prependOlder, reconcile, sessionMessageToItem, taskListDockLine, taskListProgress, taskListSettledLabel } from "./chat-thread";

const row = (id: string, role: string, content: string, createdAt = "2026-11-01T10:00:00.000Z") => ({ id, conversationId: "c1", role, content, createdAt }) as never;
const user = (id: string, text: string, createdAt?: string): ChatItem => ({ id, kind: "user", text, ...(createdAt ? { createdAt } : {}) });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text });
const tasks = (runId: string, ...statuses: Array<"pending" | "in_progress" | "completed">): ChatItem => ({ id: `task-list-${runId}`, kind: "task-list", runId, items: statuses.map((status, i) => ({ content: `passo ${i + 1}`, status })) });

describe("sessionMessageToItem", () => {
	it("usuário e assistente viram balões; vazio some", () => {
		expect(sessionMessageToItem(row("1", "user", "oi"))).toMatchObject({ kind: "user", text: "oi" });
		expect(sessionMessageToItem(row("2", "assistant", "olá"))).toMatchObject({ kind: "assistant", text: "olá" });
		expect(sessionMessageToItem(row("3", "assistant", "  "))).toBeNull();
	});
	it("o clique de um cartão (confirmado/recusado/cancela isso) não aparece como fala", () => {
		expect(sessionMessageToItem(row("1", "user", "confirmado: criar rotina"))).toBeNull();
		expect(sessionMessageToItem(row("2", "user", "cancela isso"))).toBeNull();
		expect(sessionMessageToItem(row("3", "user", "recusado"))).toBeNull();
	});
	it("cartão de lista de tarefas, aprovação e gráfico", () => {
		const list = JSON.stringify({ v: 1, kind: "task-list", runId: "r1", items: [{ content: "a", status: "completed" }] });
		expect(sessionMessageToItem(row("t", "task-list", list))).toMatchObject({ kind: "task-list", runId: "r1" });
		const confirm = JSON.stringify({ v: 1, kind: "confirm", confirmId: "k1", title: "Criar rotina?", status: "pending" });
		expect(sessionMessageToItem(row("c", "confirm", confirm))).toMatchObject({ kind: "confirm", confirmId: "k1", status: "pending" });
		expect(sessionMessageToItem(row("x", "chart", "não é json"))).toBeNull();
	});
	it("papel desconhecido e rascunho revisado não aparecem", () => {
		expect(sessionMessageToItem(row("1", "tool", "x"))).toBeNull();
	});
});

describe("página", () => {
	it("parsePage descarta linha malformada e lê hasMore", () => {
		expect(parsePage({ messages: [row("1", "user", "a"), { id: 3 }], hasMore: true })?.messages).toHaveLength(1);
		expect(parsePage({ messages: [], hasMore: true })?.hasMore).toBe(true);
		expect(parsePage({})).toBeNull();
		expect(parsePage(null)).toBeNull();
	});
	it("o cursor é o mais antigo (primeiro) e a rota leva beforeCreatedAt e beforeId", () => {
		expect(oldestCursor([{ id: "a", createdAt: "t1" }, { id: "b", createdAt: "t2" }])).toEqual({ createdAt: "t1", id: "a" });
		expect(oldestCursor([])).toBeNull();
		expect(messagesPath("c 1", { limit: 30, before: { createdAt: "2026-11-01T10:00:00.000Z", id: "m9" } })).toBe("/v1/conversations/c%201/messages?limit=30&beforeCreatedAt=2026-11-01T10%3A00%3A00.000Z&beforeId=m9");
		expect(messagesPath("c1")).toBe("/v1/conversations/c1/messages");
	});
	it("prependOlder põe as velhas antes e não repete id", () => {
		const out = prependOlder([user("3", "c")], [user("1", "a"), user("3", "c"), user("2", "b")]);
		expect(out.map((item) => item.id)).toEqual(["1", "2", "3"]);
	});
	it("mergeTail troca o fim a partir do primeiro id conhecido e mantém o que é mais velho", () => {
		const current = [user("1", "a"), user("2", "b"), bot("3", "c")];
		const tail = [bot("3", "c2"), bot("4", "d")];
		const { items, gap } = mergeTail(current, tail);
		expect(items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
		expect(gap).toBe(false);
		expect((items[2] as { text: string }).text).toBe("c2");
	});
	it("mergeTail sem nenhum id em comum é lacuna: vale o fim buscado", () => {
		const { items, gap } = mergeTail([user("1", "a")], [user("8", "x"), user("9", "y")]);
		expect(items.map((item) => item.id)).toEqual(["8", "9"]);
		expect(gap).toBe(true);
	});
	it("mergeTail com fim vazio não muda nada", () => {
		expect(mergeTail([user("1", "a")], []).items).toHaveLength(1);
	});
});

describe("reconcile (gravado × ao vivo)", () => {
	it("balão otimista some quando o servidor gravou o mesmo texto", () => {
		const sentAt = Date.parse("2026-11-01T10:00:00.000Z");
		const optimistic = user(`msg-${sentAt}-abc`, "me lembra  amanhã");
		const persisted = [user("db1", "me lembra amanhã", "2026-11-01T10:00:01.000Z")];
		expect(reconcile(persisted, [optimistic]).map((item) => item.id)).toEqual(["db1"]);
	});
	it("a otimista fica enquanto o servidor não gravou, depois do gravado", () => {
		const out = reconcile([bot("a1", "olá")], [user("msg-1-x", "oi de novo")]);
		expect(out.map((item) => item.id)).toEqual(["a1", "msg-1-x"]);
	});
	it("mesma fala enviada antes (linha antiga) não engole a nova", () => {
		const sentAt = Date.parse("2026-11-01T10:00:00.000Z");
		const old = user("old", "oi", "2026-10-01T10:00:00.000Z");
		const out = reconcile([old], [user(`msg-${sentAt}-x`, "oi")]);
		expect(out).toHaveLength(2);
	});
	it("fala em andamento some quando as linhas gravadas já a cobrem (uma linha por parágrafo)", () => {
		const live: ChatItem = { id: "cu-1", kind: "assistant", text: "Primeiro parágrafo da resposta.\n\nSegundo parágrafo." };
		const persisted = [bot("a1", "Primeiro parágrafo da resposta."), bot("a2", "Segundo parágrafo.")];
		expect(reconcile(persisted, [live]).map((item) => item.id)).toEqual(["a1", "a2"]);
		expect(persistedAssistantCovers(persisted, live.kind === "assistant" ? live.text : "")).toBe(true);
	});
	it("falas curtas iguais não se cobrem", () => {
		expect(reconcile([bot("a1", "Ok.")], [{ id: "cu-1", kind: "assistant", text: "Ok." }])).toHaveLength(2);
	});
	it("a fala em andamento fica no fim enquanto não gravada", () => {
		const out = reconcile([user("u1", "oi")], [{ id: "cu-1", kind: "assistant", text: "Pensando em voz alta aqui" }]);
		expect(out.map((item) => item.id)).toEqual(["u1", "cu-1"]);
	});
	it("cartão ao vivo com a identidade de um gravado não aparece duas vezes", () => {
		const live: ChatItem = { id: "confirm-k1", kind: "confirm", confirmId: "k1", title: "X?", status: "pending" };
		const persisted: ChatItem = { id: "db-confirm", kind: "confirm", confirmId: "k1", title: "X?", status: "approved" };
		const out = reconcile([persisted], [live]);
		expect(out).toEqual([persisted]);
	});
	it("a lista de tarefas ao vivo do mesmo run troca os passos do gravado e não duplica", () => {
		const persisted: ChatItem = { id: "db-t", kind: "task-list", runId: "r1", items: [{ content: "a", status: "pending" }] };
		const live = tasks("r1", "completed", "in_progress");
		const out = reconcile([persisted], [live]);
		expect(out).toHaveLength(1);
		expect((out[0] as { items: unknown[] }).items).toHaveLength(2);
	});
	it("dedupeKeys remove cartões iguais e ids repetidos", () => {
		const card = (id: string): ChatItem => ({ id, kind: "web-card", card: "chart", title: "Gráfico", key: "chart:1" });
		expect(dedupeKeys([card("a"), card("b"), user("u", "x"), user("u", "x")]).map((item) => item.id)).toEqual(["a", "u"]);
	});
});

describe("lista de tarefas", () => {
	it("progresso, linha da doca e rótulo do fio", () => {
		const items = tasks("r", "completed", "in_progress", "pending", "pending", "pending");
		if (items.kind !== "task-list") throw new Error();
		expect(taskListProgress(items.items)).toMatchObject({ total: 5, done: 1, allDone: false });
		expect(taskListDockLine(items.items)).toBe("1/5 · passo 2");
		expect(taskListSettledLabel(items.items)).toBe("Tarefas · 1/5");
		const done = tasks("r", "completed", "completed");
		if (done.kind !== "task-list") throw new Error();
		expect(taskListDockLine(done.items)).toBe("2/2 · Tudo pronto");
		expect(taskListSettledLabel(done.items)).toBe("Tarefas · 2/2 concluídas");
	});
	it("sem pendência, a próxima pendente é a atual", () => {
		const list = tasks("r", "completed", "pending");
		if (list.kind !== "task-list") throw new Error();
		expect(taskListProgress(list.items).current?.content).toBe("passo 2");
	});
	it("a doca só existe com run ativo, depois da última fala do usuário e amarrada ao run", () => {
		const thread = [user("u0", "antes"), tasks("r0", "completed"), user("u1", "agora"), tasks("r1", "in_progress")];
		expect(dockedTaskList(thread, false)).toBeNull();
		expect(dockedTaskList(thread, true, "r1")?.runId).toBe("r1");
		// lista de um run antigo depois da última fala do usuário não fica presa na doca de outro run
		expect(dockedTaskList([user("u", "x"), tasks("r0", "in_progress")], true, "r1")).toBeNull();
		// a de antes da última fala do usuário nunca é a doca
		expect(dockedTaskList([tasks("r0", "in_progress"), user("u", "x")], true, "r0")).toBeNull();
		expect(dockedTaskList([user("u", "x"), tasks("local", "in_progress")], true, "r1")?.runId).toBe("local");
	});
	it("lista vazia não vira doca", () => {
		expect(dockedTaskList([user("u", "x"), { id: "t", kind: "task-list", runId: "r", items: [] }], true)).toBeNull();
	});
});
