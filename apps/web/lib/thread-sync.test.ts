import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { applyServerTail, createThreadSync } from "./thread-sync";
import { newMessagesSince } from "./unread";

const user = (id: string, text: string): Message => ({ id, kind: "user", text });
const bot = (id: string, text: string): Message => ({ id, kind: "assistant", text });
const confirm = (id: string, status: "pending" | "approved" = "pending"): Message => ({
	id,
	kind: "confirm",
	title: "Google Agenda: executar create_event?",
	status,
	confirmId: "cf-1",
});
const ids = (messages: Message[]) => messages.map((message) => message.id);

/** Servidor falso: a lista persistida por conversa, fotos atrasadas (réplica) e falhas de rede. */
class FakeServer {
	messages = new Map<string, Message[]>();
	fetches = 0;
	staleSnapshots: Message[][] = [];
	failNext = 0;
	persist(conversationId: string, ...items: Message[]) {
		this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), ...items]);
	}
	async fetchTail(conversationId: string): Promise<Message[]> {
		this.fetches += 1;
		if (this.failNext > 0) {
			this.failNext -= 1;
			throw new Error("rede indisponível");
		}
		const stale = this.staleSnapshots.shift();
		return stale ?? [...(this.messages.get(conversationId) ?? [])];
	}
}

/** Tela de uma conversa: o que o hook mantém em `messages` + o controlador de sincronização. */
function openConversation(server: FakeServer, conversationId: string, screen: { messages: Message[]; current: boolean }) {
	return createThreadSync({
		fetchTail: () => server.fetchTail(conversationId),
		apply: (update) => {
			screen.messages = update(screen.messages);
		},
		isCurrent: () => screen.current,
		wait: async () => undefined,
	});
}

test("cenário 2: o run termina enquanto o usuário está em outro bot, ao voltar a resposta aparece", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "pesquise X"));

	// Em A: o stream mostra um placeholder parcial.
	const screenA1 = { messages: [user("db-u1", "pesquise X"), bot("cu-1", "Pesquisando")], current: true };
	// Vai para B: a tela de A é descartada e o stream de A é abortado (nada mais aplica nela).
	screenA1.current = false;
	// Enquanto isso o worker conclui o run e persiste a resposta.
	server.persist("conv-a", bot("db-a1", "Aqui está X, completo."));

	// Volta para A: tela nova, vazia, abre e sincroniza.
	const screenA2 = { messages: [] as Message[], current: true };
	const sync = openConversation(server, "conv-a", screenA2);
	assert.equal(await sync.sync({ runLive: false, retries: 1 }), true);
	assert.deepEqual(ids(screenA2.messages), ["db-u1", "db-a1"]);
});

test("cenário 1: stream morto no segundo plano, ao voltar a resposta substitui o placeholder sem duplicar", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "faça Y"), bot("db-a1", "Y feito."));
	const screen = { messages: [user("db-u1", "faça Y"), bot("cu-7", "Y fe")], current: true };
	const sync = openConversation(server, "conv-a", screen);
	await sync.sync({ runLive: false, resultText: "Y feito.", retries: 2 });
	assert.deepEqual(ids(screen.messages), ["db-u1", "db-a1"]);
	// repetir é idempotente (resume + sinal da lista + fim do stream ao mesmo tempo)
	await sync.sync({ runLive: false, resultText: "Y feito.", retries: 2 });
	await sync.sync({ runLive: false });
	assert.deepEqual(ids(screen.messages), ["db-u1", "db-a1"]);
});

test("placeholder cujo texto é só um trecho da resposta persistida também sai quando não há run vivo", () => {
	const merged = applyServerTail(
		[user("db-u1", "oi"), bot("cu-1", "Resposta parc")],
		[user("db-u1", "oi"), bot("db-a1", "Resposta parcial e final.")],
		{ runLive: false },
	);
	assert.deepEqual(ids(merged), ["db-u1", "db-a1"]);
});

test("com run vivo o placeholder do stream continua (a resposta ainda não está no banco)", () => {
	const merged = applyServerTail([user("db-u1", "oi"), bot("cu-1", "Pensando")], [user("db-u1", "oi")], { runLive: true });
	assert.deepEqual(ids(merged), ["db-u1", "cu-1"]);
});

test("réplica atrasada: insiste até a resposta persistida aparecer", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "oi"), bot("db-a1", "Olá! Tudo certo."));
	server.staleSnapshots.push([user("db-u1", "oi")]);
	const screen = { messages: [user("db-u1", "oi")], current: true };
	await openConversation(server, "conv-a", screen).sync({ runLive: false, resultText: "Olá! Tudo certo.", retries: 3 });
	assert.deepEqual(ids(screen.messages), ["db-u1", "db-a1"]);
	assert.equal(server.fetches, 2);
});

test("falha de rede ao voltar não perde a tela e a próxima tentativa funciona", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "oi"), bot("db-a1", "Olá"));
	server.failNext = 2;
	const screen = { messages: [user("db-u1", "oi"), bot("cu-1", "Ol")], current: true };
	const sync = openConversation(server, "conv-a", screen);
	assert.equal(await sync.sync({ runLive: false, retries: 0 }), false);
	assert.deepEqual(ids(screen.messages), ["db-u1", "cu-1"]);
	assert.equal(await sync.sync({ runLive: false, retries: 3 }), true);
	assert.deepEqual(ids(screen.messages), ["db-u1", "db-a1"]);
});

test("busca antiga que termina depois de uma nova não desfaz a resposta", async () => {
	const screen = { messages: [user("db-u1", "oi")], current: true };
	let release: (tail: Message[]) => void = () => undefined;
	const slow = new Promise<Message[]>((resolve) => {
		release = resolve;
	});
	let call = 0;
	const sync = createThreadSync({
		fetchTail: () => {
			call += 1;
			return call === 1 ? slow : Promise.resolve([user("db-u1", "oi"), bot("db-a1", "pronto")]);
		},
		apply: (update) => {
			screen.messages = update(screen.messages);
		},
		isCurrent: () => true,
		wait: async () => undefined,
	});
	const first = sync.sync({ runLive: false });
	await sync.sync({ runLive: false });
	release([user("db-u1", "oi")]);
	assert.equal(await first, false);
	assert.deepEqual(ids(screen.messages), ["db-u1", "db-a1"]);
});

test("conversa que saiu da tela não recebe a resposta de outra", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "oi"), bot("db-a1", "A"));
	const screen = { messages: [] as Message[], current: true };
	const sync = openConversation(server, "conv-a", screen);
	const pending = sync.sync({ runLive: false });
	screen.current = false;
	assert.equal(await pending, false);
	assert.deepEqual(screen.messages, []);
});

test("aprovação pendente: o card ao vivo continua único e a resposta não o apaga", async () => {
	const server = new FakeServer();
	server.persist("conv-a", user("db-u1", "agende"), confirm("db-c1"));
	const screen = { messages: [user("db-u1", "agende"), confirm("cf-1"), bot("cu-2", "Preciso da sua aprovação")], current: true };
	await openConversation(server, "conv-a", screen).sync({ runLive: true, retries: 1 });
	assert.equal(screen.messages.filter((message) => message.kind === "confirm").length, 1);
	const card = screen.messages.find((message) => message.kind === "confirm");
	assert.equal(card?.kind === "confirm" ? card.status : null, "pending");
	// card ainda não persistido (gravado depois): não some no sync
	const lone = applyServerTail([user("db-u1", "agende"), confirm("cf-9")], [user("db-u1", "agende")], { runLive: true });
	assert.equal(lone.filter((message) => message.kind === "confirm").length, 1);
});

test("histórico antigo já carregado na tela fica intacto quando só o fim é buscado", () => {
	const older = [user("db-1", "a"), bot("db-2", "b"), user("db-3", "c"), bot("db-4", "d")];
	const tail = [bot("db-4", "d"), user("db-5", "e"), bot("db-6", "f")];
	const merged = applyServerTail([...older, user("msg-1", "e"), bot("cu-1", "f")], tail, { runLive: false });
	assert.deepEqual(ids(merged), ["db-1", "db-2", "db-3", "db-4", "db-5", "db-6"]);
});

test("N novas: a resposta que chega conta uma vez e a vista que virou id persistido não infla a conta", () => {
	const before = [user("db-u1", "oi"), bot("cu-1", "Resp")];
	const seen = before.at(-1)!.id;
	const after = applyServerTail(before, [user("db-u1", "oi"), bot("db-a1", "Resposta")], { runLive: false });
	assert.deepEqual(ids(after), ["db-u1", "db-a1"]);
	// o id visto sumiu: sem ponto de partida não há "N novas" (antes contava todas as mensagens do bot)
	assert.equal(newMessagesSince(after, seen), 0);
	// com ponto de partida estável, a resposta nova conta uma vez
	assert.equal(newMessagesSince(after, "db-u1"), 1);
	const again = applyServerTail(after, [user("db-u1", "oi"), bot("db-a1", "Resposta")], { runLive: false });
	assert.equal(newMessagesSince(again, "db-u1"), 1);
});

// ---- ordem com mensagens enviadas durante o run ativo ------------------------------------------------------

const SCENARIO = [
	"Vc n fez o login, puxe do cofre",
	"O cofre tem o login chatgpt salvo",
	"N consegue né",
	"A página ainda mostra a tela de login",
	"Mas eh falei do gpt",
	"Consigo sim: o login do Claude está no cofre",
	"Pronto, entrei no ChatGPT",
];
const texts = (messages: Message[]) => messages.map((m) => (m.kind === "user" || m.kind === "assistant" ? m.text : m.kind));

test("3 mensagens do usuário durante o run, intercaladas com falas do bot: tela, reconciliação e recarga na mesma ordem", async () => {
	const server = new FakeServer();
	// Ao vivo: o usuário mandou 3 vezes (otimistas msg-*) e o bot falou entre elas (bolhas cu-*).
	const screen = {
		messages: [
			user("db-0", "pedido inicial"),
			user("msg-1", SCENARIO[0]!),
			bot("cu-s1", SCENARIO[1]!),
			user("msg-2", SCENARIO[2]!),
			bot("cu-s2", SCENARIO[3]!),
			user("msg-3", SCENARIO[4]!),
			bot("cu-reply1", SCENARIO[5]!),
		] as Message[],
		current: true,
	};
	// Servidor: cada linha gravada no instante em que aconteceu (ids de banco, ordem por createdAt).
	server.persist(
		"c1",
		user("db-0", "pedido inicial"),
		user("db-1", SCENARIO[0]!),
		bot("db-2", SCENARIO[1]!),
		user("db-3", SCENARIO[2]!),
		bot("db-4", SCENARIO[3]!),
		user("db-5", SCENARIO[4]!),
		bot("db-6", SCENARIO[5]!),
	);
	const sync = openConversation(server, "c1", screen);
	await sync.sync({ runLive: true });
	assert.deepEqual(texts(screen.messages), ["pedido inicial", ...SCENARIO.slice(0, 6)]);

	// O run termina: o texto final entra depois de tudo e a tela não reordena nada.
	server.persist("c1", bot("db-7", SCENARIO[6]!));
	await sync.sync({ runLive: false, resultText: SCENARIO[6] });
	assert.deepEqual(texts(screen.messages), ["pedido inicial", ...SCENARIO]);
	assert.deepEqual(ids(screen.messages), ["db-0", "db-1", "db-2", "db-3", "db-4", "db-5", "db-6", "db-7"]);

	// Recarregar (tela vazia + fim persistido) mostra o mesmo.
	const reloaded = { messages: [] as Message[], current: true };
	await openConversation(server, "c1", reloaded).sync({ runLive: false });
	assert.deepEqual(texts(reloaded.messages), ["pedido inicial", ...SCENARIO]);
});

test("otimistas e falas ao vivo ainda sem gravar ficam logo depois do que as precede, não no fim", async () => {
	const server = new FakeServer();
	// O servidor já tem as 3 mensagens do usuário e a 1ª fala; a 2ª e a 3ª falas só existem ao vivo.
	server.persist("c1", user("db-0", "u0"), user("db-1", "u1"), bot("db-2", "a1"), user("db-3", "u2"), user("db-4", "u3"));
	const screen = {
		messages: [user("db-0", "u0"), user("msg-1", "u1"), bot("cu-a1", "a1"), user("msg-2", "u2"), bot("cu-a2", "a2"), user("msg-3", "u3"), bot("cu-a3", "a3")] as Message[],
		current: true,
	};
	await openConversation(server, "c1", screen).sync({ runLive: true });
	assert.deepEqual(texts(screen.messages), ["u0", "u1", "a1", "u2", "a2", "u3", "a3"]);
});
