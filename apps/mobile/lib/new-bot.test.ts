import { AVATAR_COLORS } from "@workspace/shared/avatar/identity";
import { DRAWABLE_SHAPES, SHAPE_IDS } from "@workspace/shared/avatar/geometry/shapes";
import { describe, expect, it, vi } from "vitest";
import { createBot, createErrorText } from "./bot-api";
import { ChatApiError } from "./chat-api";
import { buildNewBotBody, canCreateBot, NEW_BOT_COLORS, NEW_BOT_SHAPES, randomAvatar, seededRandom } from "./new-bot";

const BLUE = "#1084FE";

describe("sorteio inicial de forma e cor", () => {
	it("com a mesma semente dá sempre o mesmo resultado", () => {
		expect(randomAvatar(seededRandom(42))).toEqual(randomAvatar(seededRandom(42)));
		expect(randomAvatar(seededRandom(7))).toEqual(randomAvatar(seededRandom(7)));
	});
	it("só sorteia ids do motor (forma desenhável, cor da paleta, nunca o preto) em qualquer semente", () => {
		const shapes = new Set<string>();
		const colors = new Set<string>();
		for (let seed = 0; seed < 400; seed += 1) {
			const { shape, color } = randomAvatar(seededRandom(seed));
			expect(DRAWABLE_SHAPES as readonly string[]).toContain(shape);
			expect(AVATAR_COLORS.map((item) => item.value)).toContain(color);
			expect(color).not.toBe("#000000");
			shapes.add(shape);
			colors.add(color);
		}
		// o sorteio varia de verdade (não fica preso numa forma ou cor)
		expect(shapes.size).toBeGreaterThan(4);
		expect(colors.size).toBeGreaterThan(6);
	});
	it("nos extremos do gerador (0 e quase 1) escolhe a primeira e a última sem sair da lista", () => {
		expect(randomAvatar(() => 0).shape).toBe(DRAWABLE_SHAPES[0]);
		expect(randomAvatar(() => 0.999999).shape).toBe(DRAWABLE_SHAPES[DRAWABLE_SHAPES.length - 1]);
	});
	it("as grades usam todas as formas do motor e toda a paleta", () => {
		expect(NEW_BOT_SHAPES).toEqual([...SHAPE_IDS]);
		expect(NEW_BOT_COLORS.map((item) => item.id)).toContain("gray");
		expect(NEW_BOT_COLORS).toHaveLength(AVATAR_COLORS.length);
	});
});

describe("corpo do POST /v1/bots", () => {
	it("só nome, forma e cor: nada de idioma, modelo, descrição nem membros", () => {
		const check = buildNewBotBody({ name: "  Estoquinho  ", shape: "hex", color: BLUE });
		expect(check).toEqual({ ok: true, body: { name: "Estoquinho", shape: "hex", color: BLUE } });
		if (check.ok) expect(Object.keys(check.body).sort()).toEqual(["color", "name", "shape"]);
	});
	it("nome vazio, só espaços ou comprido demais é barrado", () => {
		for (const name of ["", "   ", "\n\t "]) expect(buildNewBotBody({ name, shape: "hex", color: BLUE }).ok).toBe(false);
		expect(buildNewBotBody({ name: "a".repeat(81), shape: "hex", color: BLUE }).ok).toBe(false);
		expect(buildNewBotBody({ name: "a".repeat(80), shape: "hex", color: BLUE }).ok).toBe(true);
	});
	it("forma e cor fora dos ids do motor são barradas (o servidor as ignoraria em silêncio)", () => {
		expect(buildNewBotBody({ name: "X", shape: "rond", color: BLUE })).toMatchObject({ ok: false });
		expect(buildNewBotBody({ name: "X", shape: "", color: BLUE })).toMatchObject({ ok: false });
		expect(buildNewBotBody({ name: "X", shape: "hex", color: "#123456" })).toMatchObject({ ok: false });
		expect(buildNewBotBody({ name: "X", shape: "hex", color: "blue" })).toMatchObject({ ok: false });
	});
	it("a cor volta no hex canônico da paleta, mesmo vindo em minúsculas", () => {
		expect(buildNewBotBody({ name: "X", shape: "blob", color: "#1084fe" })).toMatchObject({ ok: true, body: { color: BLUE } });
	});
	it("Criar só habilita com nome válido e fora de uma criação em andamento", () => {
		expect(canCreateBot("", false)).toBe(false);
		expect(canCreateBot("   ", false)).toBe(false);
		expect(canCreateBot("Ana", false)).toBe(true);
		expect(canCreateBot("Ana", true)).toBe(false);
	});
});

const created = { id: "b9", name: "Estoquinho", snippet: "", color: BLUE, shape: "hex", description: null, openRouterModel: null, language: "auto", pinned: false, pinOrder: null, notify: false, sectionId: null, memberIds: [], conversationId: "conv-9", lastMessage: null };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("createBot (POST /v1/bots)", () => {
	it("manda o corpo recebido e devolve o bot como a home desenha, com a conversa dele", async () => {
		const fetch = reply(201, created);
		const bot = await createBot(fetch, { name: "Estoquinho", shape: "hex", color: BLUE });
		const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(path).toBe("/v1/bots");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ name: "Estoquinho", shape: "hex", color: BLUE });
		expect(bot).toMatchObject({ id: "b9", name: "Estoquinho", color: BLUE, shape: "hex", conversationId: "conv-9", pinned: false, isPrimary: false, preview: "" });
	});
	it("400, 503 e 401 viram ChatApiError; corpo torto vira 502; rede propaga", async () => {
		for (const status of [400, 503, 401]) await expect(createBot(reply(status, { error: "x" }), { name: "X", shape: "hex", color: BLUE })).rejects.toMatchObject({ status });
		await expect(createBot(reply(201, { ok: true }), { name: "X", shape: "hex", color: BLUE })).rejects.toMatchObject({ status: 502 });
		await expect(createBot(vi.fn(async () => Promise.reject(new TypeError("Network request failed"))), { name: "X", shape: "hex", color: BLUE })).rejects.toBeInstanceOf(TypeError);
	});
	it("frases de erro simples", () => {
		expect(createErrorText(new ChatApiError("x", 400))).toBe("Algum dado não foi aceito. Confira o nome e tente de novo.");
		expect(createErrorText(new ChatApiError("x", 401))).toBe("Sua sessão expirou. Entre de novo.");
		expect(createErrorText(new ChatApiError("x", 503))).toBe("Não consegui criar o bot agora. Tente de novo.");
		expect(createErrorText(new TypeError("Network request failed"))).toBe("Sem conexão com o seu servidor. Tente de novo.");
	});
});
