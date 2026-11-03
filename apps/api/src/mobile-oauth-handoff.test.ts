/**
 * Passagem de sessão do app para o navegador (mobile-oauth-handoff.ts). Banco em memória, sem rede.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";

const OWNER = "owner@example.test";
process.env.ATLAS_OWNER_EMAIL = OWNER;
process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret";
process.env.ATLAS_URL = "http://localhost:3000";

const { createAuth } = await import("./auth.js");
const { createOAuthHandoff, createMobileOAuthHandoffRoutes, createHandoffSessionRevoker, handoffResponseHeaders, parseOAuthClient, MOBILE_OAUTH_HANDOFF_PATH, OAUTH_HANDOFF_USER_AGENT } = await import("./mobile-oauth-handoff.js");
const { isPublicV1Request, createRequireUser } = await import("./middleware/auth.js");
const { rateLimitByIp } = await import("./middleware/rate-limit.js");

const ORIGIN = "http://localhost:3000";
const NEXT = "https://accounts.example.com/authorize?client_id=abc&state=SERVER_STATE";

type Row = Record<string, unknown>;

async function setup(clock = { now: Date.now() }) {
	const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [], rateLimit: [] };
	const auth = createAuth({ database: memoryAdapter(db) });
	const ctx = await auth.$context;
	const now = () => clock.now;
	const handoff = createOAuthHandoff({ auth, baseOrigin: ORIGIN, now });
	const routes = createMobileOAuthHandoffRoutes({ auth, baseOrigin: ORIGIN, now });
	const addUser = async (id: string, email: string) => {
		db.user!.push({ id, email, name: id, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
		// Sessão "do app" do usuário (a que pede o handoff).
		const session = await ctx.internalAdapter.createSession(id, false, { userAgent: "atlas-app" });
		return session as { id: string; token: string; userId: string };
	};
	const open = (url: string, init: RequestInit = {}) => routes.request(url, init);
	return { auth, ctx, db, handoff, routes, addUser, open, clock };
}

const tokenOf = (url: string) => new URL(url).searchParams.get("t") as string;
const pathOf = (url: string) => { const u = new URL(url); return `${u.pathname}${u.search}`; };
const sessionCookie = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

test("parseOAuthClient: só o literal mobile; ausente = web; outro valor falha com a lista aceita", () => {
	assert.deepEqual(parseOAuthClient({}), { ok: true, mobile: false });
	assert.deepEqual(parseOAuthClient(null), { ok: true, mobile: false });
	assert.deepEqual(parseOAuthClient({ client: "mobile" }), { ok: true, mobile: true });
	for (const bad of ["web", "Mobile", "", 1, true, null, {}]) {
		const result = parseOAuthClient({ client: bad });
		assert.equal(result.ok, false, String(bad));
		if (!result.ok) assert.match(result.error, /mobile/);
	}
});

test("mint devolve URL absoluta com token de 32 bytes e guarda só o hash", async () => {
	const { handoff, addUser, db } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT });
	assert.ok(url.startsWith(`${ORIGIN}${MOBILE_OAUTH_HANDOFF_PATH}?t=`));
	const token = tokenOf(url);
	assert.equal(Buffer.from(token, "base64url").length, 32);
	assert.ok(db.verification!.length === 1);
	assert.ok(!JSON.stringify(db.verification).includes(token), "o token cru não vai ao banco");
});

test("abrir o link: 302 para o next do servidor, cookie de sessão do mesmo usuário, sem t na Location", async () => {
	const { handoff, addUser, open, auth } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT });
	const res = await open(pathOf(url), { headers: { referer: "https://evil.example" } });
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), NEXT);
	assert.ok(!res.headers.get("location")?.includes(tokenOf(url)), "Location sem o t");
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.equal(res.headers.get("referrer-policy"), "no-referrer");
	const setCookie = res.headers.getSetCookie().join("\n");
	assert.match(setCookie, /better-auth\.session_token=/);
	assert.match(setCookie, /HttpOnly/i);
	assert.match(setCookie, /SameSite=Lax/i);
	assert.match(setCookie, /Path=\//);
	assert.match(setCookie, /Max-Age=600\b/);
	assert.ok(!setCookie.includes("Secure"), "http em teste: sem Secure");
	// Item 6: a sessão gravada pelo handoff é do MESMO usuário que pediu (e é uma sessão nova, curta, marcada).
	const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie(res) }) });
	assert.equal(session?.user.id, "user-a");
	assert.equal(session?.session.userAgent, OAUTH_HANDOFF_USER_AGENT);
	assert.notEqual(session?.session.id, app.id);
	assert.notEqual(session?.session.token, app.token, "não reaproveita o token da sessão do app");
});

test("uso único: o segundo uso do mesmo código falha", async () => {
	const { handoff, addUser, open } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	assert.equal((await open(url)).status, 302);
	const second = await open(url);
	assert.equal(second.status, 410);
	assert.equal(second.headers.get("cache-control"), "no-store");
	assert.equal(second.headers.get("referrer-policy"), "no-referrer");
	assert.equal(second.headers.getSetCookie().length, 0);
	assert.match(await second.text(), /Link expirado\. Volte ao app e tente de novo\./);
});

test("uso único sob concorrência: só uma das aberturas simultâneas passa", async () => {
	const { handoff, addUser, open } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	const results = await Promise.all([open(url), open(url), open(url)]);
	assert.equal(results.filter((r) => r.status === 302).length, 1);
});

test("expira em 60 s", async () => {
	const { handoff, addUser, open, clock } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	clock.now += 61_000;
	const res = await open(url);
	assert.equal(res.status, 410);
	assert.equal(res.headers.getSetCookie().length, 0);
	// Dentro da janela passa.
	const fresh = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	clock.now += 59_000;
	assert.equal((await open(fresh)).status, 302);
});

test("não serve para outro dono: sessão de B não vale para o usuário A, e a sessão criada é sempre a do dono do código", async () => {
	const { handoff, addUser, open, auth } = await setup();
	const a = await addUser("user-a", OWNER);
	const b = await addUser("user-b", "other@example.test");
	// Código pedido com a sessão de B mas dizendo ser de A: recusado.
	const forged = pathOf(await handoff.mint({ userId: "user-a", sessionId: b.id, next: NEXT }));
	assert.equal((await open(forged)).status, 410);
	// Código de B legítimo gera sessão de B, nunca de A.
	const legit = await open(pathOf(await handoff.mint({ userId: "user-b", sessionId: b.id, next: NEXT })));
	assert.equal(legit.status, 302);
	const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie(legit) }) });
	assert.equal(session?.user.id, "user-b");
	assert.notEqual(session?.user.id, a.userId);
});

test("amarrado à sessão que pediu: sessão do app revogada mata o código", async () => {
	const { handoff, addUser, open, ctx } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	await ctx.internalAdapter.deleteSession(app.token);
	assert.equal((await open(url)).status, 410);
});

test("o destino é o next gravado no servidor: query do cliente não muda o redirect", async () => {
	const { handoff, addUser, open } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT }));
	const res = await open(`${url}&next=https://evil.example&redirect=https://evil.example`);
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), NEXT);
});

test("token ausente, malformado ou inventado: 410 genérico, sem detalhe", async () => {
	const { open } = await setup();
	for (const query of ["", "?t=", "?t=abc", `?t=${"A".repeat(43)}`, `?t=${"A".repeat(300)}`, "?t[]=x"]) {
		const res = await open(`${MOBILE_OAUTH_HANDOFF_PATH}${query}`);
		assert.equal(res.status, 410, query);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.equal(res.headers.get("referrer-policy"), "no-referrer");
		assert.equal(res.headers.getSetCookie().length, 0);
		const text = await res.text();
		assert.ok(!/error|stack|prisma|verification/i.test(text));
	}
});

test("mint recusa next que não é http(s)", async () => {
	const { handoff, addUser } = await setup();
	const app = await addUser("user-a", OWNER);
	for (const next of ["javascript:alert(1)", "atlas://x", "not a url"]) {
		await assert.rejects(handoff.mint({ userId: "user-a", sessionId: app.id, next }), Error, next);
	}
});

test("a rota não escreve o token em log (console) em nenhum desfecho", async () => {
	const { handoff, addUser, open } = await setup();
	const app = await addUser("user-a", OWNER);
	const url = await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT });
	const token = tokenOf(url);
	const lines: string[] = [];
	const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	for (const key of Object.keys(originals) as (keyof typeof originals)[]) console[key] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		await open(pathOf(url));
		await open(pathOf(url));
	} finally {
		Object.assign(console, originals);
	}
	assert.ok(!lines.join("\n").includes(token));
});

test("limite por IP na rota pública: estourou, 429 (com no-store e no-referrer)", async () => {
	const { routes } = await setup();
	const app = new Hono();
	app.use(MOBILE_OAUTH_HANDOFF_PATH, handoffResponseHeaders);
	app.use(MOBILE_OAUTH_HANDOFF_PATH, rateLimitByIp(2, 60_000));
	app.route("/", routes);
	const hit = () =>
		app.request(`${MOBILE_OAUTH_HANDOFF_PATH}?t=${"A".repeat(43)}`, {}, { incoming: { socket: { remoteAddress: "192.0.2.9", remotePort: 1, remoteFamily: "IPv4" } } });
	assert.equal((await hit()).status, 410);
	assert.equal((await hit()).status, 410);
	const limited = await hit();
	assert.equal(limited.status, 429);
	assert.equal(limited.headers.get("cache-control"), "no-store");
	assert.equal(limited.headers.get("referrer-policy"), "no-referrer");
});

test("edge: a ordem real do servidor aplica o limite à rota (registerEdgeMiddleware)", async () => {
	const { registerEdgeMiddleware } = await import("./middleware/edge.js");
	const { routes } = await setup();
	const app = new Hono();
	registerEdgeMiddleware(app, { corsOrigins: [ORIGIN] });
	app.route("/", routes);
	const hit = () =>
		app.request(`${MOBILE_OAUTH_HANDOFF_PATH}?t=${"A".repeat(43)}`, {}, { incoming: { socket: { remoteAddress: "192.0.2.10", remotePort: 1, remoteFamily: "IPv4" } } });
	let last = 0;
	for (let i = 0; i < 31; i += 1) last = (await hit()).status;
	assert.equal(last, 429);
});

test("allowlist: só GET /v1/mobile/oauth-handoff é público; o resto de /v1/mobile não", () => {
	assert.equal(isPublicV1Request("GET", "/v1/mobile/oauth-handoff"), true);
	for (const [method, path] of [
		["POST", "/v1/mobile/oauth-handoff"],
		["HEAD", "/v1/mobile/oauth-handoff"],
		["GET", "/v1/mobile/oauth-handoff/"],
		["GET", "/v1/mobile/oauth-handoff/x"],
		["GET", "/v1/mobile"],
		["GET", "/v1/mobile/other"],
		["POST", "/v1/mobile/other"],
		["GET", "/v1/mobile/oauth-handoffx"],
	] as const) {
		assert.equal(isPublicV1Request(method, path), false, `${method} ${path}`);
	}
});

test("requireUser: sem sessão, outra rota sob /v1/mobile responde 401 (e as rotas de gerar o link também)", async () => {
	const { auth } = await setup();
	const app = new Hono();
	app.use("/v1/*", createRequireUser(auth));
	app.get("/v1/mobile/other", (c) => c.text("x"));
	app.post("/v1/mcp/connections", (c) => c.text("x"));
	app.post("/v1/mcp/connections/:id/reauth", (c) => c.text("x"));
	app.post("/v1/composio/connect", (c) => c.text("x"));
	assert.equal((await app.request("/v1/mobile/other")).status, 401);
	for (const path of ["/v1/mcp/connections", "/v1/mcp/connections/1/reauth", "/v1/composio/connect"]) {
		assert.equal((await app.request(path, { method: "POST", body: JSON.stringify({ client: "mobile" }) })).status, 401, path);
	}
});

test("a sessão curta é revogada ao fim do callback do OAuth (e a do app não é tocada)", async () => {
	const { handoff, addUser, open, auth, ctx } = await setup();
	const app = await addUser("user-a", OWNER);
	const res = await open(pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT })));
	const cookie = sessionCookie(res);
	const callback = new Hono();
	callback.use("/cb", createHandoffSessionRevoker(auth));
	callback.get("/cb", (c) => c.text("ok"));
	assert.equal((await callback.request("/cb", { headers: { cookie } })).status, 200);
	assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
	assert.ok(await ctx.internalAdapter.findSession(app.token), "sessão do app continua");
});

test("a sessão curta não é estendida pelo refresh do better-auth; a sessão do app continua renovando", async () => {
	const { handoff, addUser, open, auth, db } = await setup();
	const app = await addUser("user-a", OWNER);
	const res = await open(pathOf(await handoff.mint({ userId: "user-a", sessionId: app.id, next: NEXT })));
	const cookie = sessionCookie(res);
	const short = db.session!.find((row) => row.userAgent === OAUTH_HANDOFF_USER_AGENT) as Row;
	const before = (short.expiresAt as Date).getTime();
	// Vários getSession (o navegador usando o Atlas sem concluir o OAuth): nenhum estende.
	for (let i = 0; i < 3; i += 1) {
		const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
		assert.equal(session?.user.id, "user-a");
	}
	assert.equal((short.expiresAt as Date).getTime(), before);
	assert.ok(before - Date.now() <= 10 * 60_000);
	// Sessão normal do app, já "devida" para refresh (2 dias de vida), é renovada.
	const row = db.session!.find((r) => r.id === app.id) as Row;
	row.expiresAt = new Date(Date.now() + 2 * 86_400_000);
	const appCookie = `better-auth.session_token=${encodeURIComponent(`${app.token}.${await signValue(app.token)}`)}`;
	const renewed = await auth.api.getSession({ headers: new Headers({ cookie: appCookie }) });
	assert.equal(renewed?.session.id, app.id);
	assert.ok((row.expiresAt as Date).getTime() - Date.now() > 6 * 86_400_000, "app renovou");
});

async function signValue(value: string): Promise<string> {
	const { createHmac } = await import("node:crypto");
	return createHmac("sha256", process.env.BETTER_AUTH_SECRET as string).update(value).digest("base64");
}
