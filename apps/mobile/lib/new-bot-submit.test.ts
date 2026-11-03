import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import type { HomeBot } from "./home-types";
import { createNewBotSubmitter, type NewBotDeps } from "./new-bot-submit";

const bot: HomeBot = { id: "b9", name: "Estoquinho", color: "#1084FE", shape: "hex", pinned: false, pinOrder: null, sectionId: null, memberIds: [], isPrimary: false, conversationId: "conv-9", language: "auto", unread: false, lastAt: null, preview: "", previewSent: false };
const input = { name: "Estoquinho", shape: "hex", color: "#1084FE" };
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

function setup(over: Partial<NewBotDeps> = {}) {
	const order: string[] = [];
	const deps: NewBotDeps = {
		createBot: vi.fn(async () => (order.push("create"), bot)),
		addBot: vi.fn(() => void order.push("add")),
		refresh: vi.fn(async () => void order.push("refresh")),
		onUnauthorized: vi.fn(),
		...over,
	};
	return { deps, order, submit: createNewBotSubmitter(deps) };
}

describe("Criar bot", () => {
	it("cria, insere na home e só então atualiza em segundo plano; devolve o id para abrir o chat", async () => {
		const { deps, order, submit } = setup();
		expect(await submit(input)).toEqual({ ok: true, botId: "b9" });
		expect(order).toEqual(["create", "add", "refresh"]);
		expect(deps.createBot).toHaveBeenCalledWith({ name: "Estoquinho", shape: "hex", color: "#1084FE" });
		expect(deps.addBot).toHaveBeenCalledWith(bot);
	});
	it("nome vazio ou só espaços não chama a rede", async () => {
		const { deps, submit } = setup();
		expect(await submit({ ...input, name: "   " })).toMatchObject({ ok: false });
		expect(deps.createBot).not.toHaveBeenCalled();
	});
	it("forma ou cor fora dos ids do motor não chama a rede", async () => {
		const { deps, submit } = setup();
		expect(await submit({ ...input, shape: "rond" })).toMatchObject({ ok: false });
		expect(await submit({ ...input, color: "#123456" })).toMatchObject({ ok: false });
		expect(deps.createBot).not.toHaveBeenCalled();
	});
	it("toque duplo com a criação em voo cria um bot só", async () => {
		const gate = deferred<HomeBot>();
		const { deps, submit } = setup({ createBot: vi.fn(() => gate.promise) });
		const first = submit(input);
		expect(await submit(input)).toBeNull();
		gate.resolve(bot);
		expect(await first).toEqual({ ok: true, botId: "b9" });
		expect(deps.createBot).toHaveBeenCalledOnce();
		expect(deps.addBot).toHaveBeenCalledOnce();
	});
	it("depois de criado, outro toque (a navegação ainda não saiu) não cria de novo", async () => {
		const { deps, submit } = setup();
		await submit(input);
		expect(await submit(input)).toBeNull();
		expect(deps.createBot).toHaveBeenCalledOnce();
	});
	it("erro do servidor devolve frase simples, não insere nada e libera uma nova tentativa", async () => {
		let attempt = 0;
		const { deps, submit } = setup({ createBot: vi.fn(async () => (++attempt === 1 ? Promise.reject(new ChatApiError("Failed to create bot", 503)) : bot)) });
		expect(await submit(input)).toEqual({ ok: false, error: "Não consegui criar o bot agora. Tente de novo." });
		expect(deps.addBot).not.toHaveBeenCalled();
		expect(await submit(input)).toEqual({ ok: true, botId: "b9" });
	});
	it("sem rede: Sem conexão; 401 encerra a sessão", async () => {
		const offline = setup({ createBot: vi.fn(async () => Promise.reject(new TypeError("Network request failed"))) });
		expect(await offline.submit(input)).toEqual({ ok: false, error: "Sem conexão com o seu servidor. Tente de novo." });
		const expired = setup({ createBot: vi.fn(async () => Promise.reject(new ChatApiError("x", 401))) });
		expect(await expired.submit(input)).toMatchObject({ ok: false });
		expect(expired.deps.onUnauthorized).toHaveBeenCalledOnce();
	});
	it("falha da atualização em segundo plano não desfaz a criação", async () => {
		const { submit } = setup({ refresh: vi.fn(async () => Promise.reject(new Error("rede"))) });
		expect(await submit(input)).toEqual({ ok: true, botId: "b9" });
	});
});
