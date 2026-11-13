/**
 * Cartões salvos e mandato (F6.2/F6.4): caminho feliz, validação, IDOR (40-seguranca) e vazamento. Sem banco: o "db" é um
 * mapa em memória que filtra por dono como o real (o filtro real está em `saved-cards.db.test.ts`).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/cards.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { createCardRoutes } = await import("./cards.js");

const A = "cards-owner-a";
const B = "cards-owner-b";
const T0 = new Date("2026-11-07T12:00:00.000Z");
const NUMBER = "4111 1111 1111 1111";
const body = { number: NUMBER, holder: "TESTE DA SILVA", expMonth: 12, expYear: 2030, billing: { line1: "Rua Teste 1", city: "Sao Paulo", state: "SP", postalCode: "01000-000", country: "BR" } };

function world(configured = true) {
	const cards: Array<{ id: string; userId: string; label: string; brand: string; last4: string; secretsEnc: string; createdAt: Date }> = [];
	const mandates = new Map<string, { id: string; maxAmount: number; currency: string; merchants: string[]; until: Date; usesLeft: number; rev: number }>();
	let seq = 0;
	const routes = createCardRoutes({
		now: () => T0,
		configured: () => configured,
		seal: (secrets) => `sealed:${Buffer.from(JSON.stringify(secrets)).toString("base64")}`,
		create: async (userId, input) => {
			const row = { id: `card-${++seq}`, userId, ...input, createdAt: T0 };
			cards.push(row);
			return row;
		},
		list: async (userId) => cards.filter((c) => c.userId === userId),
		remove: async (userId, id) => {
			const i = cards.findIndex((c) => c.id === id && c.userId === userId);
			if (i >= 0) cards.splice(i, 1);
			return i >= 0;
		},
		getMandate: async (userId) => mandates.get(userId) ?? null,
		putMandate: async (userId, input) => {
			const row = { id: "m1", maxAmount: input.maxAmount, currency: input.currency.toUpperCase(), merchants: input.merchants.map((m) => m.toLowerCase()), until: input.until, usesLeft: input.uses, rev: 0 };
			mandates.set(userId, row);
			return row;
		},
		removeMandate: async (userId) => mandates.delete(userId),
	});
	return { cards, mandates, routes };
}

function appFor(routes: Hono<AuthEnv>, userId: string) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: T0, updatedAt: T0 }, session: { id: "s", token: "t", userId, expiresAt: T0, createdAt: T0, updatedAt: T0, ipAddress: null, userAgent: null } });
		await next();
	});
	app.route("/", routes);
	return app;
}
const send = (app: Hono<AuthEnv>, method: string, path: string, json?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(json !== undefined && { body: JSON.stringify(json) }) });

test("salvar: sela os dados, devolve só rótulo, bandeira e final e a lista nunca traz número, nome, validade ou endereço", async () => {
	const w = world();
	const a = appFor(w.routes, A);
	const res = await send(a, "POST", "/v1/cards", body);
	assert.equal(res.status, 201);
	const created = await res.text();
	assert.deepEqual(Object.keys((JSON.parse(created) as { card: object }).card).sort(), ["brand", "createdAt", "id", "label", "last4"]);
	const list = await (await send(a, "GET", "/v1/cards")).text();
	for (const secret of ["4111", "TESTE DA SILVA", "Rua Teste", "2030", "sealed:"]) {
		assert.equal(created.includes(secret), false, `criação vazou ${secret}`);
		assert.equal(list.includes(secret), false, `lista vazou ${secret}`);
	}
	assert.match(list, /"last4":"1111"/);
	// o que foi ao db está selado (não em claro)
	assert.equal(w.cards[0]!.secretsEnc.includes("4111"), false);
	assert.equal(w.cards[0]!.brand, "visa");
});

test("o CVV não existe: corpo com cvv/cvc/csc é 400 e nada é salvo", async () => {
	const w = world();
	const a = appFor(w.routes, A);
	for (const field of ["cvv", "cvc", "csc", "securityCode"]) assert.equal((await send(a, "POST", "/v1/cards", { ...body, [field]: "737" })).status, 400);
	assert.equal(w.cards.length, 0);
});

test("validação: Luhn, validade vencida e erro que não ecoa o que foi digitado", async () => {
	const w = world();
	const a = appFor(w.routes, A);
	const bad = await send(a, "POST", "/v1/cards", { ...body, number: "4111 1111 1111 1112" });
	assert.equal(bad.status, 400);
	assert.equal((await bad.text()).includes("4111"), false);
	assert.equal((await send(a, "POST", "/v1/cards", { ...body, expYear: 2025 })).status, 400);
	assert.equal((await send(a, "POST", "/v1/cards", "lixo")).status, 400);
	assert.equal(w.cards.length, 0);
});

test("sem a chave do servidor o cartão não é gravado (503), nunca em claro", async () => {
	const w = world(false);
	assert.equal((await send(appFor(w.routes, A), "POST", "/v1/cards", body)).status, 503);
	assert.equal(w.cards.length, 0);
});

test("IDOR: B não vê, não apaga e não herda o cartão de A; userId em corpo ou query não vira escopo", async () => {
	const w = world();
	const a = appFor(w.routes, A);
	const b = appFor(w.routes, B);
	const id = ((await (await send(a, "POST", "/v1/cards", body)).json()) as { card: { id: string } }).card.id;
	assert.deepEqual(((await (await send(b, "GET", `/v1/cards?userId=${A}`)).json()) as { cards: unknown[] }).cards, []);
	assert.equal((await send(b, "DELETE", `/v1/cards/${id}?userId=${A}`)).status, 404);
	assert.equal(w.cards.length, 1);
	assert.equal((await send(a, "DELETE", `/v1/cards/${id}`)).status, 200);
	assert.equal((await send(a, "DELETE", `/v1/cards/${id}`)).status, 404);
});

test("mandato: cria, lê, substitui e apaga; prazo no passado ou longo demais e corpo extra são 400; B não vê o de A", async () => {
	const w = world();
	const a = appFor(w.routes, A);
	const b = appFor(w.routes, B);
	const ok = { maxAmount: 300, currency: "brl", merchants: ["Loja.Test"], until: "2026-12-01T00:00:00Z", uses: 2 };
	assert.equal((await send(a, "PUT", "/v1/purchase-mandate", ok)).status, 200);
	const read = (await (await send(a, "GET", "/v1/purchase-mandate")).json()) as { mandate: { currency: string; usesLeft: number; merchants: string[] } };
	assert.deepEqual({ c: read.mandate.currency, u: read.mandate.usesLeft, m: read.mandate.merchants }, { c: "BRL", u: 2, m: ["loja.test"] });
	assert.equal(((await (await send(b, "GET", "/v1/purchase-mandate")).json()) as { mandate: unknown }).mandate, null);
	assert.equal((await send(a, "PUT", "/v1/purchase-mandate", { ...ok, until: "2026-01-01T00:00:00Z" })).status, 400);
	assert.equal((await send(a, "PUT", "/v1/purchase-mandate", { ...ok, until: "2030-01-01T00:00:00Z" })).status, 400);
	assert.equal((await send(a, "PUT", "/v1/purchase-mandate", { ...ok, userId: B })).status, 400);
	// loja é normalizada como o checkout compara (domínio, minúsculo, sem www, punycode) e lixo é 400 com mensagem clara
	const urlForm = await send(a, "PUT", "/v1/purchase-mandate", { ...ok, merchants: ["https://www.Loja.Test/checkout", "loja.test", "Lojá.com.br"] });
	assert.equal(urlForm.status, 200);
	assert.deepEqual(((await urlForm.json()) as { mandate: { merchants: string[] } }).mandate.merchants, ["loja.test", "xn--loj-gla.com.br"]);
	for (const bad of ["loja", "127.0.0.1", "minha loja", "ftp://loja.test"]) {
		const res = await send(a, "PUT", "/v1/purchase-mandate", { ...ok, merchants: ["loja.test", bad] });
		assert.equal(res.status, 400, bad);
		const body = (await res.json()) as { error: string; message: string };
		assert.equal(body.error, "invalid_merchant");
		assert.match(body.message, /domínio válido/);
	}
	assert.equal((await send(b, "DELETE", "/v1/purchase-mandate")).status, 404);
	assert.equal((await send(a, "DELETE", "/v1/purchase-mandate")).status, 200);
});
