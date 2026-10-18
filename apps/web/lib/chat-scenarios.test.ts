import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { SimClient, SimServer, summarize } from "./chat-sim.testkit";
import { parseNotificationTarget } from "./notification-link";
import { createSseReplayGuard } from "./sse-replay";
import { adoptLoadedThread } from "./thread-live";
import { createThreadSync } from "./thread-sync";

const FINAL = "Achei três opções.\n\nA primeira é a mais barata.\n\nA terceira entrega amanhã.";

const confirmCard = (id: string, status: "pending" | "approved" = "pending"): Message => ({
	id,
	kind: "confirm",
	title: "Google Agenda: executar create_event?",
	status,
	confirmId: "cf-1",
});

function assertNoDuplicateIds(messages: Message[]) {
	const ids = messages.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, `ids repetidos: ${ids.join(",")}`);
}

test("duas mensagens do usuário enviadas rápido com run em andamento mantêm a ordem de envio", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("primeira");
	server.user("primeira");
	client.delta("s1", "Vou verificar isso agora");
	client.send("segunda");
	// o servidor ainda só tem a primeira
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.summary, ["user:primeira", "assistant:Vou verificar isso agora", "user:segunda"]);
	server.assistant("Vou verificar isso agora");
	server.user("segunda");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.summary, summarize(server.head));
	server.assistant(FINAL, "paragraph");
	client.fetch(server.head, { runLive: false, resultText: FINAL });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
});

test("duas mensagens idênticas seguidas ('ok', 'ok') não colapsam em uma nem se duplicam", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("ok");
	client.send("ok");
	server.user("ok");
	client.fetch(server.head, { runLive: true });
	assert.equal(client.screen.filter((m) => m.kind === "user").length, 2);
	server.user("ok");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.ids, ["db-1", "db-2"]);
});

test("duas respostas do bot seguidas (segmento + final) viram duas linhas, nunca uma bolha extra", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("faça");
	server.user("faça");
	client.delta("s1", "Primeiro passo concluído.");
	client.delta("s2", "Segundo passo concluído.");
	server.assistant("Primeiro passo concluído.");
	server.assistant("Segundo passo concluído.");
	client.fetch(server.head, { runLive: false });
	assert.deepEqual(client.ids, ["db-1", "db-2", "db-3"]);
});

test("bolha ao vivo + versão persistida (parágrafos/linhas) viram exatamente uma, em todas as formas de gravação", () => {
	for (const split of ["none", "paragraph", "line"] as const) {
		for (const runLive of [true, false]) {
			const server = new SimServer();
			const client = new SimClient();
			client.send("pesquise");
			server.user("pesquise");
			client.delta("s1", FINAL.slice(0, 20));
			client.delta("s1", FINAL.slice(20));
			server.assistant(FINAL, split);
			client.fetch(server.head, { runLive, resultText: runLive ? null : FINAL });
			if (!runLive) assert.deepEqual(client.ids, server.head.map((m) => m.id), `split=${split}`);
			else assert.equal(client.screen.filter((m) => m.kind === "assistant").length, server.head.filter((m) => m.kind === "assistant").length, `split=${split} live`);
			assertNoDuplicateIds(client.screen);
		}
	}
});

test("multi-segmento: passo com tool, fala do usuário no meio e resposta final", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("u1");
	server.user("u1");
	client.delta("s1", "Vou buscar essa informação.");
	server.assistant("Vou buscar essa informação.");
	server.tool("web_search", "resultado da busca");
	client.send("u2");
	server.user("u2");
	client.delta("s2", FINAL);
	server.assistant(FINAL, "paragraph");
	client.fetch(server.head, { runLive: false, resultText: FINAL });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
	assert.deepEqual(summarize(client.screen).slice(0, 4), ["user:u1", "assistant:Vou buscar essa informação.", "tool:resultado da busca", "user:u2"]);
});

test("segmento já gravado e depois o stream entrega o delta atrasado: não fica balão duplicado", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("u1");
	server.user("u1");
	server.assistant("Vou buscar essa informação.");
	client.fetch(server.head, { runLive: true });
	// o delta do mesmo passo só chega agora
	client.delta("s1", "Vou buscar essa informação.");
	assert.equal(client.screen.filter((m) => m.kind === "assistant").length, 1, client.summary.join(" | "));
});

test("recarregar com o run vivo (link de push) não duplica os passos já gravados", () => {
	const server = new SimServer();
	server.user("u1");
	server.assistant("Vou buscar essa informação.");
	server.tool("web_search", "ok");
	const client = new SimClient();
	client.reloadMidRun(server.head, [
		{ type: "assistant_delta", id: "s1", delta: "Vou buscar essa informação." },
		{ type: "assistant_delta", id: "s2", delta: "Estou compilando" },
	]);
	assert.deepEqual(client.summary, ["user:u1", "assistant:Vou buscar essa informação.", "tool:ok", "assistant:Estou compilando"]);
});

test("SSE cai no meio do stream e o resync traz o resto sem duplicar o que já estava na tela", async () => {
	const server = new SimServer();
	server.user("u1");
	const client = new SimClient();
	client.reload(server.head);
	client.delta("s1", "Resposta em andam");
	// conexão morreu; o servidor termina o run
	server.assistant("Resposta em andamento completa.");
	const sync = createThreadSync({
		fetchTail: async () => server.head,
		apply: (update) => {
			client.screen = update(client.screen);
		},
		isCurrent: () => true,
		wait: async () => undefined,
	});
	await sync.sync({ runLive: false, resultText: "Resposta em andamento completa.", retries: 2 });
	assert.deepEqual(client.ids, ["db-1", "db-2"]);
});

test("volta do segundo plano no meio do run: tela com bolha parcial, servidor já avançou", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("u1");
	server.user("u1");
	client.delta("s1", "Passo um foi concluído.");
	// em segundo plano: o servidor grava o passo 1 e a ferramenta
	server.assistant("Passo um foi concluído.");
	server.tool("t", "r");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
	client.delta("s2", "Passo dois foi concluído.");
	server.assistant("Passo dois foi concluído.");
	client.fetch(server.head, { runLive: false });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
});

test("run que termina em cartão (precisa do usuário): confirmar o cartão e vir a resposta", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("crie o evento");
	server.user("crie o evento");
	client.delta("s1", "Preciso da sua confirmação.");
	client.liveCard(confirmCard("cf-1"));
	server.assistant("Preciso da sua confirmação.");
	server.card(confirmCard("db-card"));
	client.fetch(server.head, { runLive: false });
	assert.equal(client.screen.filter((m) => m.kind === "confirm").length, 1);
	assert.deepEqual(client.ids, ["db-1", "db-2", "db-card"]);
	// confirma: sobe "confirmado" como novo turno e a resposta vem depois
	client.send("confirmado: Google Agenda: executar create_event?");
	server.user("confirmado: Google Agenda: executar create_event?");
	server.rows = server.rows.map((m) => (m.kind === "confirm" ? confirmCard(m.id, "approved") : m));
	server.assistant("Evento criado.");
	client.fetch(server.head, { runLive: false, resultText: "Evento criado." });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
	assert.equal((client.screen.find((m) => m.kind === "confirm") as Extract<Message, { kind: "confirm" }>).status, "approved");
});

test("hub desligado (só polling): buscas repetidas e fora de ordem convergem sem duplicar", async () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("u1");
	server.user("u1");
	const snapshots: Message[][] = [server.head];
	client.delta("s1", "Vou verificar isso agora.");
	server.assistant("Vou verificar isso agora.");
	snapshots.push(server.head);
	server.assistant(FINAL, "paragraph");
	snapshots.push(server.head);
	// poll de 1 s devolve fotos fora de ordem e repetidas (réplica atrasada)
	let calls = 0;
	const order = [2, 0, 2, 1, 2, 2];
	const sync = createThreadSync({
		fetchTail: async () => snapshots[order[calls++ % order.length]!]!,
		apply: (update) => {
			client.screen = update(client.screen);
		},
		isCurrent: () => true,
		wait: async () => undefined,
	});
	for (let i = 0; i < order.length; i += 1) await sync.sync({ runLive: false, retries: 0 });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
});

test("abrir pelo link de push (?bot=&card=) com run em andamento: alvo lido e thread sem duplicar", () => {
	assert.deepEqual(parseNotificationTarget("?bot=b1&card=cf-1"), { botId: "b1", cardId: "cf-1" });
	const server = new SimServer();
	server.user("u1");
	server.assistant("Vou verificar isso agora.");
	server.card(confirmCard("db-card"));
	const client = new SimClient();
	client.reloadMidRun(server.head, [
		{ type: "assistant_delta", id: "s1", delta: "Vou verificar isso agora." },
		{ type: "assistant_delta", id: "s2", delta: "Aguardando" },
	]);
	assert.deepEqual(client.ids, ["db-1", "db-2", "db-card", "cu-s2"]);
});

test("replay do stream depois da reconexão não reaplica eventos", () => {
	const guard = createSseReplayGuard(0);
	const seen: number[] = [];
	for (const id of [1, 2, 3, 2, 3, 4, 1, 4, 5]) if (guard.accept(id)) seen.push(id);
	assert.deepEqual(seen, [1, 2, 3, 4, 5]);
	assert.equal(guard.cursor, 5);
	assert.equal(guard.accept(undefined), true);
	// aviso fora da sequência (id 0) não é descartado nem mexe no cursor
	assert.equal(createSseReplayGuard(0).accept(0), true);
	assert.equal(createSseReplayGuard(7).accept(7), false);
	assert.equal(createSseReplayGuard(7).accept(8), true);
});

test("sem run vivo, bolha local com parágrafos cujas linhas persistidas têm uma ferramenta no meio também sai", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("u1");
	server.user("u1");
	client.delta("s1", "Primeiro passo concluído.\n\nSegundo passo concluído.");
	server.assistant("Primeiro passo concluído.");
	server.tool("web_search", "resultado");
	server.assistant("Segundo passo concluído.");
	client.fetch(server.head, { runLive: false });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
});

test("segunda mensagem enviada antes da fala do bot ser gravada não passa na frente da primeira", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("pergunta um");
	server.user("pergunta um");
	client.send("pergunta dois");
	client.delta("s1", "Resposta do primeiro passo.");
	client.send("pergunta três");
	// o servidor grava a fala do passo e só então a segunda pergunta; a terceira ainda não chegou
	server.assistant("Resposta do primeiro passo.");
	server.user("pergunta dois");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.summary, ["user:pergunta um", "assistant:Resposta do primeiro passo.", "user:pergunta dois", "user:pergunta três"]);
});

test("a linha gravada cobre só o começo do balão: os deltas seguintes não recriam um balão com o resto", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("conte");
	server.user("conte");
	client.delta("s1", "Primeiro parágrafo da resposta.");
	// o servidor grava a resposta em linhas, uma por vez; a primeira já está lá
	server.assistant("Primeiro parágrafo da resposta.");
	client.fetch(server.head, { runLive: true });
	client.delta("s1", "\n\nSegundo parágrafo da resposta.");
	assert.deepEqual(client.summary, ["user:conte", "assistant:Primeiro parágrafo da resposta."]);
	server.assistant("Segundo parágrafo da resposta.");
	client.fetch(server.head, { runLive: false });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
});

test("conversa nova: a bolha do stream não sobe para antes da mensagem do usuário quando o fim é buscado", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("primeira de todas");
	client.delta("s1", "Respondendo à primeira de todas.");
	server.user("primeira de todas");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.summary, ["user:primeira de todas", "assistant:Respondendo à primeira de todas."]);
});

test("abre a conversa com run vivo e o usuário envia antes da foto carregar: a fala não some e depois casa com a gravada", () => {
	const server = new SimServer();
	server.user("pedido antigo");
	server.assistant("Resposta antiga, bem comprida.");
	const client = new SimClient();
	// a foto do servidor foi tirada antes do envio
	const loaded = server.head;
	client.send("mais uma coisa agora");
	client.screen = adoptLoadedThread(loaded, client.screen);
	assert.deepEqual(client.summary, ["user:pedido antigo", "assistant:Resposta antiga, bem comprida.", "user:mais uma coisa agora"]);
	server.user("mais uma coisa agora");
	client.fetch(server.head, { runLive: true });
	assert.deepEqual(client.ids, server.head.map((m) => m.id));
	// sem fala pendente a foto vira a tela como está
	assert.equal(adoptLoadedThread(loaded, []), loaded);
});
