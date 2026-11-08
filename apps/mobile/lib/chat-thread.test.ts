import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { dropDayPlanHeadlineEcho, taskCardActive, dedupeKeys, dockedTaskList, mergeTail, messagesPath, oldestCursor, parsePage, persistedAssistantCovers, prependOlder, reconcile, sessionMessageToItem, withSourceMarkers, taskListDockLine, taskListProgress, taskListSettledLabel } from "./chat-thread";

const row = (id: string, role: string, content: string, createdAt = "2026-11-01T10:00:00.000Z") => ({ id, conversationId: "c1", role, content, createdAt }) as never;
const user = (id: string, text: string, createdAt?: string): ChatItem => ({ id, kind: "user", text, ...(createdAt ? { createdAt } : {}) });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text });
const tasks = (runId: string, ...statuses: Array<"pending" | "in_progress" | "completed">): ChatItem => ({ id: `task-list-${runId}`, kind: "task-list", runId, items: statuses.map((status, i) => ({ content: `passo ${i + 1}`, status })) });

describe("reações e origem", () => {
	it("lê as reações válidas (uma por ator) e a origem da fala do bot", () => {
		const user = { ...(row("1", "user", "valeu") as object), reactions: [{ actor: "bot", emoji: "❤️" }, { actor: "bot", emoji: "👍" }, { actor: "x", emoji: "🙂" }] };
		expect(sessionMessageToItem(user as never)).toMatchObject({ reactions: [{ actor: "bot", emoji: "❤️" }] });
		expect(sessionMessageToItem(row("2", "user", "oi"))).not.toHaveProperty("reactions");
		const source = { kind: "routine", label: "Resumo da agenda", at: "2026-11-02T10:00:00.000Z" };
		expect(sessionMessageToItem({ ...(row("3", "assistant", "agenda") as object), source } as never)).toMatchObject({ source });
	});
	it("marcador de rotina acima da fala que abre o trecho; falas seguidas da mesma execução ficam sob um só", () => {
		const source = { kind: "routine" as const, label: "Resumo da agenda", at: "2026-11-02T10:00:00.000Z" };
		const items: ChatItem[] = [
			{ id: "u", kind: "user", text: "oi" },
			{ id: "a1", kind: "assistant", text: "1)", source },
			{ id: "a2", kind: "assistant", text: "2)", source },
			{ id: "a3", kind: "assistant", text: "normal" },
		];
		const out = withSourceMarkers(items, "America/Sao_Paulo");
		expect(out.map((item) => item.id)).toEqual(["u", "source-a1", "a1", "a2", "a3"]);
		expect(out[1]).toMatchObject({ kind: "marker", text: expect.stringContaining("Resumo da agenda") });
	});
	it("cartão no meio do trecho fecha o trecho (novo marcador), como no web", () => {
		const source = { kind: "routine" as const, label: "Resumo", at: "2026-11-02T10:00:00.000Z" };
		const items: ChatItem[] = [
			{ id: "a1", kind: "assistant", text: "1", source },
			{ id: "m", kind: "marker", text: "Conversa compactada" },
			{ id: "a2", kind: "assistant", text: "2", source },
		];
		expect(withSourceMarkers(items).map((item) => item.id)).toEqual(["source-a1", "a1", "m", "source-a2", "a2"]);
	});
});

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
	it("plano do dia, agenda e e-mail gravados aparecem no celular (antes sumiam: o papel não estava na lista)", () => {
		const plan = JSON.stringify({ v: 1, kind: "day-plan", planId: "p1", date: "2026-11-05", timeZone: "America/Sao_Paulo", headline: "Dia leve", sections: [{ id: "commitments", items: [{ text: "Reunião", time: "14:00" }] }], sourceErrors: [{ source: "email", reason: "needs_connection" }] });
		expect(sessionMessageToItem(row("d", "day-plan", plan))).toMatchObject({ kind: "day-plan", planId: "p1", headline: "Dia leve", sections: [{ id: "commitments" }], sourceErrors: [{ source: "email", reason: "needs_connection" }] });
		const calendar = JSON.stringify({ v: 1, kind: "calendar", cardId: "c1", action: "created", timeZone: "America/Sao_Paulo", events: [{ id: "e1", title: "Dentista", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", allDay: false }] });
		expect(sessionMessageToItem(row("k", "calendar", calendar))).toMatchObject({ kind: "calendar", cardId: "c1", action: "created", events: [{ title: "Dentista" }] });
		const triage = JSON.stringify({ v: 1, kind: "email-triage", cardId: "t1", items: [{ id: "m1", category: "needs_action", summary: "Pede o recibo" }] });
		expect(sessionMessageToItem(row("t1", "email-triage", triage))).toMatchObject({ kind: "email-triage", cardId: "t1", items: [{ id: "m1" }] });
		const draft = JSON.stringify({ v: 1, kind: "email-draft", cardId: "dr1", source: "gmail", to: ["ana@exemplo.com"], subject: "Oi", body: "Texto", saved: true });
		expect(sessionMessageToItem(row("dr", "email-draft", draft))).toMatchObject({ kind: "email-draft", cardId: "dr1", subject: "Oi", saved: true });
		// Cartão malformado não vira linha quebrada.
		expect(sessionMessageToItem(row("bad", "day-plan", JSON.stringify({ v: 1, kind: "day-plan" })))).toBeNull();
	});
	it("plano do dia: a fala com a abertura (texto do push) não repete o cartão; outra fala do mesmo run e de outro run ficam", () => {
		const plan: ChatItem = { id: "p", kind: "day-plan", planId: "day-plan:run-1", date: "2026-11-05", timeZone: "America/Sao_Paulo", headline: "Hoje: 1 compromisso.", sections: [], sourceErrors: [] };
		const say = (id: string, text: string, runId: string): ChatItem => ({ id, kind: "assistant", text, runId });
		const out = dropDayPlanHeadlineEcho([say("a1", "Hoje:  1 compromisso.", "run-1"), plan, say("a2", "Quer mover a reunião?", "run-1"), say("a3", "Hoje: 1 compromisso.", "run-2")]);
		expect(out.map((item) => item.id)).toEqual(["p", "a2", "a3"]);
		expect(reconcile([say("a1", "Hoje: 1 compromisso.", "run-1"), plan], []).map((item) => item.id)).toEqual(["p"]);
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

describe("cartão de tarefas ativo", () => {
	it("só durante um run e só o cartão do run ativo", () => {
		expect(taskCardActive("r1", "r1", true)).toBe(true);
		expect(taskCardActive("r1", "r1", false)).toBe(false); // sem run: resumo
		expect(taskCardActive("r0", "r1", true)).toBe(false); // cartão de outro run
		expect(taskCardActive("r1", null, true)).toBe(false); // correndo sem lista de tarefas
	});
	it("o runId 'local' de uma execução antiga não fica ativo durante outro run", () => {
		expect(taskCardActive("local", "r2", true)).toBe(false);
		expect(taskCardActive("local", null, true)).toBe(false);
	});
});

describe("citação (replyTo)", () => {
	const quote = { id: "a1", role: "assistant" as const, text: "Pronto, enviei." };
	it("lê replyTo do servidor no balão do usuário e do bot", () => {
		expect(sessionMessageToItem({ ...(row("u1", "user", "valeu") as object), replyTo: quote } as never)).toMatchObject({ kind: "user", replyTo: quote });
		expect(sessionMessageToItem({ ...(row("a2", "assistant", "de nada") as object), replyTo: { id: "u1", role: "user", text: "valeu" } } as never)).toMatchObject({ kind: "assistant", replyTo: { id: "u1", role: "user", text: "valeu" } });
	});
	it("sem replyTo, com null ou fora do contrato: o item não leva o campo", () => {
		expect(sessionMessageToItem(row("u1", "user", "oi"))).not.toHaveProperty("replyTo");
		expect(sessionMessageToItem({ ...(row("u2", "user", "oi") as object), replyTo: null } as never)).not.toHaveProperty("replyTo");
		expect(sessionMessageToItem({ ...(row("u3", "user", "oi") as object), replyTo: { id: "a1", role: "system", text: "x" } } as never)).not.toHaveProperty("replyTo");
	});
	it("o balão otimista com citação vira o gravado: vale a do servidor", () => {
		const sentAt = Date.parse("2026-11-01T10:00:00.000Z");
		const optimistic: ChatItem = { ...user(`msg-${sentAt}-abc`, "valeu"), replyTo: quote } as ChatItem;
		const persisted: ChatItem[] = [{ ...user("db1", "valeu", "2026-11-01T10:00:01.000Z"), replyTo: { ...quote, text: "Texto do servidor" } } as ChatItem];
		expect(reconcile(persisted, [optimistic])).toEqual(persisted);
	});
	it("servidor ainda sem replyTo: a pílula local passa para a linha gravada (sem piscar)", () => {
		const sentAt = Date.parse("2026-11-01T10:00:00.000Z");
		const optimistic: ChatItem = { ...user(`msg-${sentAt}-abc`, "valeu"), replyTo: quote } as ChatItem;
		const persisted = [user("db1", "valeu", "2026-11-01T10:00:01.000Z")];
		const out = reconcile(persisted, [optimistic]);
		expect(out.map((item) => item.id)).toEqual(["db1"]);
		expect(out[0]).toMatchObject({ replyTo: quote });
		expect(persisted[0]).not.toHaveProperty("replyTo"); // não muda a lista recebida
	});
});

describe("cards do motor v4 no fio", () => {
	const approval = { type: "approval_request", requestId: "req-1", callId: "call-1", toolName: "send_email", effect: "send", args: {}, riskFacts: {}, runId: "run-1" };
	const agentCard = (id: string, settled?: boolean): ChatItem => ({ id, kind: "agent-card", card: approval as never, ...(settled ? { settled } : {}) });
	it("a linha gravada (role = tipo do evento) vira card; conteúdo inválido some", () => {
		expect(sessionMessageToItem(row("db-1", "approval_request", JSON.stringify(approval)))).toMatchObject({ id: "db-1", kind: "agent-card", card: { requestId: "req-1" } });
		expect(sessionMessageToItem(row("db-2", "approval_request", "isso não é json"))).toBeNull();
		expect(sessionMessageToItem(row("db-3", "receipt", JSON.stringify({ type: "receipt", id: "r", name: "n", what: "Feito" })))).toMatchObject({ kind: "agent-card" });
	});
	it("ao vivo e gravado (mesmo pedido do mesmo run) viram um só, o gravado; recarregar não duplica", () => {
		const persisted: ChatItem[] = [user("u1", "oi"), agentCard("db-card")];
		const live: ChatItem[] = [agentCard("agent-card-approval_request|run-1|req-1")];
		expect(reconcile(persisted, live).map((item) => item.id)).toEqual(["u1", "db-card"]);
		expect(dedupeKeys([agentCard("a"), agentCard("b")])).toHaveLength(1);
	});
	it("pedidos diferentes, ou o mesmo pedido em outro run, ficam os dois", () => {
		const other: ChatItem = { id: "x2", kind: "agent-card", card: { ...approval, requestId: "req-2" } as never };
		const otherRun: ChatItem = { id: "x3", kind: "agent-card", card: { ...approval, runId: "run-2" } as never };
		expect(dedupeKeys([agentCard("x1"), other, otherRun])).toHaveLength(3);
	});
	it("resolvido ao vivo continua resolvido quando o gravado o substitui (os botões não voltam)", () => {
		const merged = reconcile([user("u1", "oi"), agentCard("db-card")], [agentCard("agent-card-approval_request|run-1|req-1", true)]);
		expect(merged.find((item) => item.kind === "agent-card")).toMatchObject({ id: "db-card", settled: true });
	});
	it("só ao vivo (ainda sem gravado) continua na tela", () => {
		expect(reconcile([user("u1", "oi")], [agentCard("agent-card-approval_request|run-1|req-1")]).map((item) => item.kind)).toEqual(["user", "agent-card"]);
	});
});
