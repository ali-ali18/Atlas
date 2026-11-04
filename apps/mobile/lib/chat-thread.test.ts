import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { taskCardActive, dedupeKeys, dockedTaskList, mergeTail, messagesPath, oldestCursor, parsePage, persistedAssistantCovers, prependOlder, reconcile, sessionMessageToItem, withSourceMarkers, taskListDockLine, taskListProgress, taskListSettledLabel } from "./chat-thread";

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

describe("painel com revisões no fio", () => {
	const page = (id: string, revision: number, title = `Painel r${revision}`): ChatItem => ({ id, kind: "web-card", card: "page", title, key: "page:p1", pageId: "p1", revision, sourceCount: revision });
	it("gravado antigo + ao vivo mais novo: fica o novo, na posição do gravado", () => {
		const out = reconcile([user("u", "oi"), page("db-1", 1), bot("b", "pronto")], [page("page-live-p1", 2)]);
		expect(out.map((item) => item.id)).toEqual(["u", "db-1", "b"]);
		expect(out[1]).toMatchObject({ title: "Painel r2", revision: 2, sourceCount: 2 });
	});
	it("gravado mais novo que o ao vivo: vale o gravado", () => {
		const out = reconcile([page("db-1", 3)], [page("page-live-p1", 2)]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ revision: 3 });
	});
	it("dois gravados do mesmo painel: fica a maior revisão, na posição do primeiro", () => {
		const out = dedupeKeys([page("db-1", 1), user("u", "x"), page("db-2", 4), page("db-3", 2)]);
		expect(out.map((item) => item.id)).toEqual(["db-1", "u"]);
		expect(out[0]).toMatchObject({ revision: 4, title: "Painel r4" });
	});
});

describe("cartão de painel gravado", () => {
	const pageRow = (extra: Record<string, unknown> = {}) => row("m1", "page", JSON.stringify({ v: 1, kind: "page", pageId: "p1", revision: 3, title: "Vendas", action: "created", sourceCount: 2, ...extra }));
	it("guarda pageId, revisão e fontes (sem o spec) para abrir a tela nativa", () => {
		expect(sessionMessageToItem(pageRow())).toEqual({ id: "m1", kind: "web-card", card: "page", title: "Vendas", key: "page:p1", pageId: "p1", revision: 3, sourceCount: 2, createdAt: "2026-11-01T10:00:00.000Z" });
	});
	it("mensagem de painel sem identidade válida é descartada, não vira cartão quebrado", () => {
		expect(sessionMessageToItem(pageRow({ pageId: "" }))).toBeNull();
		expect(sessionMessageToItem(pageRow({ revision: 0 }))).toBeNull();
	});
});

describe("cartão de arquivo gravado", () => {
	const fileRow = (extra: Record<string, unknown> = {}) => row("m2", "file", JSON.stringify({ v: 1, kind: "file", artifactId: "f1", filename: "vm.md", mime: "text/markdown", size: 321, format: "markdown", version: 1, ...extra }));
	it("guarda fileId, mime e tamanho para abrir a folha do documento", () => {
		expect(sessionMessageToItem(fileRow())).toEqual({ id: "m2", kind: "web-card", card: "file", title: "vm.md", key: "file:f1", fileId: "f1", mime: "text/markdown", size: 321, createdAt: "2026-11-01T10:00:00.000Z" });
	});
});

describe("cartão de imagens gravado", () => {
	const imagesRow = (origin: string, extra: Record<string, unknown> = {}, id = "m3") => row(id, "images", JSON.stringify({ v: 1, kind: "images", origin, items: [{ artifactId: "a1", mime: "image/png", width: 800, height: 600, alt: "Gaveta aberta", name: "gaveta.png" }, { artifactId: "a2", mime: "image/jpeg", width: 10, height: 10 }], ...extra }));
	it("vira um cartão de imagens com a origem, as imagens e a legenda", () => {
		expect(sessionMessageToItem(imagesRow("assistant", { caption: "Resultado" }))).toEqual({
			id: "m3",
			kind: "images",
			origin: "assistant",
			images: [
				{ artifactId: "a1", mime: "image/png", width: 800, height: 600, alt: "Gaveta aberta", name: "gaveta.png" },
				{ artifactId: "a2", mime: "image/jpeg", width: 10, height: 10 },
			],
			caption: "Resultado",
			createdAt: "2026-11-01T10:00:00.000Z",
		});
	});
	it("anexo do usuário mantém a origem e não inventa legenda", () => {
		const item = sessionMessageToItem(imagesRow("user"));
		expect(item).toMatchObject({ kind: "images", origin: "user" });
		expect(item).not.toHaveProperty("caption");
	});
	it("o cartão ao vivo some quando o gravado tem os mesmos arquivos", () => {
		const saved = sessionMessageToItem(imagesRow("assistant")) as ChatItem;
		const live: ChatItem = { id: "images-r1-a1+a2", kind: "images", origin: "assistant", images: [{ artifactId: "a1", mime: "image/png", width: 800, height: 600 }, { artifactId: "a2", mime: "image/jpeg", width: 10, height: 10 }] };
		expect(reconcile([saved], [live])).toEqual([saved]);
		expect(reconcile([], [live])).toEqual([live]);
	});
	it("a mesma imagem em duas mensagens gravadas continua sendo duas (o histórico não perde cartão)", () => {
		const first = sessionMessageToItem(imagesRow("assistant", {}, "m3")) as ChatItem;
		const second = sessionMessageToItem(imagesRow("assistant", {}, "m4")) as ChatItem;
		expect(dedupeKeys([first, second])).toHaveLength(2);
		expect(reconcile([first, second], [])).toHaveLength(2);
	});
	it("o cartão ao vivo casa com um gravado por vez", () => {
		const first = sessionMessageToItem(imagesRow("assistant", {}, "m3")) as ChatItem;
		const second = sessionMessageToItem(imagesRow("assistant", {}, "m4")) as ChatItem;
		const live = (id: string): ChatItem => ({ id, kind: "images", origin: "assistant", images: [{ artifactId: "a1", mime: "image/png", width: 800, height: 600 }, { artifactId: "a2", mime: "image/jpeg", width: 10, height: 10 }] });
		expect(reconcile([first], [live("l1")])).toHaveLength(1);
		expect(reconcile([first], [live("l1"), live("l2")])).toHaveLength(2);
		expect(reconcile([first, second], [live("l1"), live("l2")])).toHaveLength(2);
	});
	it("arquivos diferentes são cartões diferentes", () => {
		const saved = sessionMessageToItem(imagesRow("assistant")) as ChatItem;
		const other: ChatItem = { id: "images-r2-z", kind: "images", origin: "assistant", images: [{ artifactId: "z", mime: "image/png", width: 1, height: 1 }] };
		expect(reconcile([saved], [other])).toHaveLength(2);
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

describe("marcador de mensagem enviada a outro bot", () => {
	it("guarda o bot destino (id e nome) e a prévia, para o avatar; o texto fica de reserva", () => {
		const content = JSON.stringify({ v: 1, kind: "sent", botMessageId: "m9", botId: "b9", botName: "Bobinho", title: "Bobinho Apoio: criação não deu certo" });
		expect(sessionMessageToItem(row("7", "bot-link", content))).toMatchObject({
			kind: "marker",
			text: "Enviou mensagem para Bobinho: Bobinho Apoio: criação não deu certo",
			link: { botId: "b9", botName: "Bobinho", title: "Bobinho Apoio: criação não deu certo" },
		});
	});
});
