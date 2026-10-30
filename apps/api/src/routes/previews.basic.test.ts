import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const {
	PREVIEW_SANDBOX_CSP,
	basicResponseHeaders,
	createPreviewBasicRoutes,
	createPreviewOpenRoutes,
	createPreviewService,
	createUpgradeDispatcher,
	rewriteLocationIntoPrefix,
} = await import("./previews.js");
const { isPublicV1Request, requireUser } = await import("../middleware/auth.js");
const { auth } = await import("../auth.js");
import type { DevSessionRecord } from "@workspace/db";
import type { AuthEnv } from "../middleware/auth.js";

const SECRET = "preview-secret";
const ID = "cmabc123def456ghi789jkl01";
const CAP = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PREFIX = `/v1/previews/${ID}/p/${CAP}/`;
const NOW = 1_800_000_000_000;
type Cfg = { baseDomain: string | null; scheme: "http" | "https"; atlasUrl: string; secret: string };
const config: Cfg = { baseDomain: null, scheme: "https", atlasUrl: "https://atlas.test", secret: SECRET };

function record(port: number, overrides: Partial<DevSessionRecord> = {}, preview: Partial<NonNullable<DevSessionRecord["preview"]>> | null = {}): DevSessionRecord {
	return {
		id: ID,
		userId: "user-a",
		conversationId: "c1",
		repo: null,
		branch: null,
		baseBranch: null,
		status: "RUNNING",
		tier: "small",
		containerId: "x",
		todos: [],
		pr: null,
		lastError: null,
		preview: preview === null ? null : { port, path: "/index.html?tab=1", startedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), cap: CAP, ...preview },
		createdAt: new Date(0),
		updatedAt: new Date(0),
		lastActiveAt: new Date(0),
		...overrides,
	};
}

type Seen = { headers: http.IncomingHttpHeaders; url: string; method: string };

async function startUpstream(seen: Seen[]) {
	const server = http.createServer((req, res) => {
		seen.push({ headers: req.headers, url: req.url ?? "", method: req.method ?? "" });
		const url = req.url ?? "";
		res.setHeader("Set-Cookie", ["sid=1; Path=/; Domain=atlas.test", "theme=dark; Path=/"]);
		res.setHeader("Content-Security-Policy", "default-src *; sandbox allow-same-origin");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		if (url.startsWith("/nasty")) {
			res.setHeader("Service-Worker-Allowed", "/");
			res.setHeader("Clear-Site-Data", '"cookies", "storage"');
			res.setHeader("Strict-Transport-Security", "max-age=0");
			res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
			res.setHeader("Expires", "Wed, 01 Jan 2099 00:00:00 GMT");
			res.setHeader("Link", "<https://evil.test/x.js>; rel=preload; as=script");
			res.setHeader("Alt-Svc", 'h3=":443"');
			res.setHeader("Report-To", '{"group":"x","max_age":1,"endpoints":[{"url":"https://evil.test"}]}');
			res.setHeader("NEL", '{"report_to":"x","max_age":1}');
			res.setHeader("Access-Control-Allow-Origin", "https://evil.test");
			res.setHeader("Access-Control-Allow-Credentials", "true");
			return void res.end("x");
		}
		if (url.startsWith("/304")) {
			res.statusCode = 304;
			return void res.end();
		}
		if (url.startsWith("/206")) {
			res.statusCode = 206;
			res.setHeader("Content-Range", "bytes 0-1/10");
			return void res.end("ab");
		}
		if (url.startsWith("/to-login")) {
			res.statusCode = 302;
			res.setHeader("Location", "/login?next=/a");
			return void res.end();
		}
		if (url.startsWith("/to-internal")) {
			const self = (server.address() as AddressInfo).port;
			res.statusCode = 302;
			res.setHeader("Location", `http://127.0.0.1:${self}/dest?x=1#h`);
			res.setHeader("Refresh", `0; url=http://localhost:${self}/r`);
			return void res.end();
		}
		if (url.startsWith("/to-prefixed")) {
			res.statusCode = 302;
			res.setHeader("Location", `${PREFIX}dest`);
			return void res.end();
		}
		if (url.startsWith("/boom")) {
			res.statusCode = 500;
			return void res.end("boom");
		}
		const types: Record<string, string> = { "/app.js": "application/javascript", "/data.json": "application/json", "/img.png": "image/png" };
		const path = url.split("?")[0]!;
		res.setHeader("Content-Type", types[path] ?? "text/html");
		res.end(path === "/img.png" ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : "<h1>oi</h1>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as AddressInfo).port };
}

async function closedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function harness(options: { cfg?: Cfg | null; session?: (port: number) => DevSessionRecord; deadUpstream?: boolean } = {}) {
	const seen: Seen[] = [];
	const upstream = await startUpstream(seen);
	const port = options.deadUpstream ? await closedPort() : upstream.port;
	const state = { now: NOW, session: (options.session ?? ((p: number) => record(p)))(port) as DevSessionRecord | null };
	const deps = {
		config: options.cfg === undefined ? config : options.cfg,
		getSessionById: async (id: string) => (state.session && id === state.session.id ? state.session : null),
		getOwnedSession: async (id: string, userId: string) => (state.session && id === state.session.id && userId === state.session.userId ? state.session : null),
		resolveContainerHost: async () => "127.0.0.1",
		touch: async () => undefined,
		now: () => state.now,
	};
	const service = createPreviewService(deps);
	const app = new Hono<AuthEnv>();
	app.use("/v1/previews/:id/p/*", basicResponseHeaders);
	app.route("/", createPreviewBasicRoutes(service));
	const open = (userId: string) => {
		const a = new Hono<AuthEnv>();
		a.use("*", async (c, next) => {
			const date = new Date();
			c.set("session", { user: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true, createdAt: date, updatedAt: date }, session: { id: "t", userId, token: "t", expiresAt: date, createdAt: date, updatedAt: date } });
			await next();
		});
		a.route("/", createPreviewOpenRoutes(deps));
		return a;
	};
	return { seen, state, service, app, open, upstreamPort: upstream.port, close: () => { upstream.server.close(); upstream.server.closeAllConnections(); } };
}

type H = Awaited<ReturnType<typeof harness>>;
const get = (h: H, path: string, init: RequestInit = {}) => h.app.request(`https://atlas.test${path}`, { redirect: "manual", ...init });

function assertBasicHeaders(res: Response, label: string): void {
	const h = res.headers;
	assert.equal(h.get("content-security-policy"), PREVIEW_SANDBOX_CSP, `${label}: CSP`);
	assert.equal(h.get("content-security-policy"), "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
	assert.doesNotMatch(h.get("content-security-policy") ?? "", /allow-same-origin|allow-top-navigation/);
	assert.equal(h.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
	assert.equal(h.get("referrer-policy"), "no-referrer", `${label}: referrer`);
	assert.equal(h.get("x-robots-tag"), "noindex, nofollow", `${label}: robots`);
	assert.equal(h.get("cross-origin-opener-policy"), "same-origin", `${label}: COOP`);
	assert.equal(h.get("cross-origin-resource-policy"), "cross-origin", `${label}: CORP`);
	assert.equal(h.get("x-frame-options"), "SAMEORIGIN", `${label}: XFO`);
	assert.equal(h.get("cache-control"), "private, no-store", `${label}: cache`);
	assert.equal(h.get("access-control-allow-origin"), "*", `${label}: ACAO`);
	assert.equal(h.get("access-control-allow-credentials"), null, `${label}: nunca com credenciais`);
	assert.equal(h.get("set-cookie"), null, `${label}: Set-Cookie`);
}

test("basico: toda resposta (html, js, json, png, 302, 500 do projeto, HEAD, 206, 304 e as recusas) leva sandbox, CORS sem credenciais e cache privado", async () => {
	const h = await harness();
	try {
		const paths = ["index.html", "app.js", "data.json", "img.png", "to-login", "boom", "206", "304"];
		const responses = await Promise.all(paths.map((p) => get(h, `${PREFIX}${p}`)));
		responses.push(await get(h, `${PREFIX}index.html`, { method: "HEAD" }));
		responses.push(await get(h, `/v1/previews/${ID}/p/errado/index.html`)); // cap errado: 401
		responses.push(await get(h, `/v1/previews/${ID}/p`)); // sem cap: 401
		responses.push(await get(h, `${PREFIX}a%2fb`)); // caminho inseguro: 404
		assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 302, 500, 206, 304, 200, 401, 401, 404]);
		responses.forEach((res, i) => assertBasicHeaders(res, `resposta ${i} (${res.status})`));
	} finally {
		h.close();
	}
});

test("basico: 502 do projeto fora do ar, 429 do limite e 500 do onError tambem levam os cabecalhos", async () => {
	const dead = await harness({ deadUpstream: true });
	try {
		const res = await get(dead, `${PREFIX}x`);
		assert.equal(res.status, 502);
		assertBasicHeaders(res, "502");
	} finally {
		dead.close();
	}
	// Espelha o index.ts: o middleware envolve o limite de IP e o onError.
	const app = new Hono();
	app.onError((_e, c) => c.text("Internal Server Error", 500));
	app.use("/v1/previews/:id/p/*", basicResponseHeaders);
	app.use("/v1/previews/:id/p/*", (c) => c.json({ error: "rate_limit_exceeded" }, 429));
	const limited = await app.request(`https://atlas.test${PREFIX}x`);
	assert.equal(limited.status, 429);
	assertBasicHeaders(limited, "429");
	const broken = new Hono();
	broken.onError((_e, c) => c.text("Internal Server Error", 500));
	broken.use("/v1/previews/:id/p/*", basicResponseHeaders);
	broken.all("/v1/previews/:id/p/*", () => {
		throw new Error("boom");
	});
	const failed = await broken.request(`https://atlas.test${PREFIX}x`);
	assert.equal(failed.status, 500);
	assertBasicHeaders(failed, "500");
});

test("basico: preflight CORS (OPTIONS) e respondido na API, sem credenciais, e nao chega ao projeto", async () => {
	const h = await harness();
	try {
		const res = await get(h, `${PREFIX}data.json`, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-custom" } });
		assert.equal(res.status, 204);
		assertBasicHeaders(res, "preflight");
		assert.equal(res.headers.get("access-control-allow-headers"), "content-type, x-custom");
		assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
		assert.equal(h.seen.length, 0);
		const wrongCap = await get(h, `/v1/previews/${ID}/p/errado/x`, { method: "OPTIONS" });
		assert.equal(wrongCap.status, 401, "sem o cap nem o preflight responde");
	} finally {
		h.close();
	}
});

test("basico: cabecalhos perigosos do projeto sao descartados (Service-Worker-Allowed, Clear-Site-Data, HSTS, Link, cache publico, CORS dele...)", async () => {
	const h = await harness();
	try {
		const res = await get(h, `${PREFIX}nasty`);
		assert.equal(res.status, 200);
		assertBasicHeaders(res, "nasty");
		for (const name of ["service-worker-allowed", "clear-site-data", "strict-transport-security", "link", "alt-svc", "report-to", "nel", "expires"]) {
			assert.equal(res.headers.get(name), null, name);
		}
		assert.doesNotMatch(res.headers.get("cache-control") ?? "", /public|s-maxage|max-age/);
	} finally {
		h.close();
	}
});

test("basico: nenhum cookie vai ao projeto, o prefixo (com o cap) e tirado do caminho e a requisicao so leva a identidade publica", async () => {
	const h = await harness();
	try {
		const res = await get(h, `${PREFIX}assets/app.js?v=2`, { headers: { cookie: "better-auth.session_token=SEGREDO; outro=1", authorization: "Bearer x", origin: "null" } });
		assert.equal(res.status, 200);
		const seen = h.seen.at(-1)!;
		assert.equal(seen.url, "/assets/app.js?v=2");
		assert.equal(seen.headers.cookie, undefined);
		assert.equal(seen.headers.authorization, undefined);
		assert.equal(seen.headers.origin, undefined);
		assert.equal(seen.headers["x-forwarded-host"], "atlas.test");
		assert.equal((await get(h, PREFIX)).status, 200);
		assert.equal(h.seen.at(-1)!.url, "/");
	} finally {
		h.close();
	}
});

test("basico: servidor com a base configurada recebe o caminho com o prefixo (basePrefixed)", async () => {
	const h = await harness({ session: (port) => record(port, {}, { basePrefixed: true }) });
	try {
		assert.equal((await get(h, `${PREFIX}src/main.js?t=1`)).status, 200);
		assert.equal(h.seen.at(-1)!.url, `${PREFIX}src/main.js?t=1`);
	} finally {
		h.close();
	}
});

test("basico: cap errado, ausente, de outra previa, vencida, parada ou sem cap gravado -> 401 'Link expirado' igual, e nada chega ao projeto", async () => {
	const h = await harness();
	try {
		const tries = [`/v1/previews/${ID}/p/errado/`, `/v1/previews/${ID}/p/`, `/v1/previews/${ID}/p`, `/v1/previews/${ID}/p/${CAP.slice(0, -1)}X/`, `/v1/previews/${"b".repeat(25)}/p/${CAP}/`];
		for (const path of tries) {
			const res = await get(h, path);
			assert.equal(res.status, 401, path);
			assert.match(await res.text(), /Link expirado/, path);
		}
		assert.equal(h.seen.length, 0);
		assert.equal((await get(h, PREFIX)).status, 200);

		h.state.now = NOW + 3_600_001;
		assert.equal((await get(h, PREFIX)).status, 401, "prévia vencida");
		h.state.now = NOW;
		h.service.invalidate(ID);
		h.state.session = record(h.upstreamPort, {}, null);
		assert.equal((await get(h, PREFIX)).status, 401, "preview_stop");
		h.state.session = record(h.upstreamPort, { status: "STOPPED" });
		assert.equal((await get(h, PREFIX)).status, 401, "ambiente parado");
		h.state.session = record(h.upstreamPort, {}, { cap: undefined });
		assert.equal((await get(h, PREFIX)).status, 401, "sem cap gravado nunca abre");
	} finally {
		h.close();
	}
});

test("basico: caminho inseguro depois do cap (%2f, %5c, //, %00, .. codificado) e 404 sem chamar o projeto", async () => {
	const h = await harness();
	try {
		for (const rest of ["a%2fb", "a%2Fb", "a%5cb", "%5c%5cevil", "a//b", "/x", "a%00b", "%2e%2e%2fsecret"]) {
			const res = await get(h, `${PREFIX}${rest}`);
			assert.equal(res.status, 404, rest);
		}
		// `..` e `%2e%2e` puros o próprio parser de URL resolve antes de rotear: caem fora do prefixo, nunca viram caminho do projeto.
		for (const rest of ["../x", "%2e%2e/x", "a/../../x"]) {
			const res = await get(h, `${PREFIX}${rest}`);
			assert.notEqual(res.status, 200, rest);
		}
		assert.equal(h.seen.length, 0);
	} finally {
		h.close();
	}
});

test("basico: no modo completo (ou desligado) o caminho /p/ nao existe (404, sem proxy)", async () => {
	for (const cfg of [{ ...config, baseDomain: "preview.test" }, null]) {
		const h = await harness({ cfg });
		try {
			const res = await get(h, PREFIX);
			assert.equal(res.status, 404);
			assertBasicHeaders(res, "modo completo");
			assert.equal(h.seen.length, 0);
		} finally {
			h.close();
		}
	}
});

test("basico: Location/Refresh entram no prefixo (com cap); relativo e ja prefixado ficam como estao", async () => {
	const h = await harness();
	try {
		assert.equal((await get(h, `${PREFIX}to-login`)).headers.get("location"), `${PREFIX}login?next=/a`);
		const internal = await get(h, `${PREFIX}to-internal`);
		assert.equal(internal.headers.get("location"), `https://atlas.test${PREFIX}dest?x=1#h`);
		assert.equal(internal.headers.get("refresh"), `0; url=https://atlas.test${PREFIX}r`);
		assert.equal((await get(h, `${PREFIX}to-prefixed`)).headers.get("location"), `${PREFIX}dest`, "sem prefixo duplicado");
		assert.equal(rewriteLocationIntoPrefix("next/page", "10.0.0.5", "https://atlas.test", PREFIX), "next/page");
		assert.equal(rewriteLocationIntoPrefix("http://10.0.0.5:3000/a", "10.0.0.5", "https://atlas.test", PREFIX), `https://atlas.test${PREFIX}a`);
	} finally {
		h.close();
	}
});

test("open (basico): dono vai ao caminho registrado dentro do prefixo com o cap, sem cookie; outro usuario, vencida, parada e sem cap dao 404", async () => {
	const h = await harness();
	try {
		const ok = await h.open("user-a").request(`/v1/previews/${ID}/open`);
		assert.equal(ok.status, 302);
		assert.equal(ok.headers.get("location"), `${PREFIX}index.html?tab=1`);
		assert.equal(ok.headers.get("cache-control"), "no-store");
		assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
		assert.equal(ok.headers.get("set-cookie"), null, "nenhum cookie: a origem opaca não os leva em pedidos CORS");
		assert.equal((await h.open("user-b").request(`/v1/previews/${ID}/open`)).status, 404, "outro usuário");
		h.state.session = record(h.upstreamPort, {}, { cap: undefined });
		assert.equal((await h.open("user-a").request(`/v1/previews/${ID}/open`)).status, 404, "sem cap");
		h.state.session = record(h.upstreamPort);
		h.state.now = NOW + 3_600_001;
		assert.equal((await h.open("user-a").request(`/v1/previews/${ID}/open`)).status, 404, "vencida");
		h.state.now = NOW;
		h.state.session = record(h.upstreamPort, {}, null);
		assert.equal((await h.open("user-a").request(`/v1/previews/${ID}/open`)).status, 404, "parada");
	} finally {
		h.close();
	}
});

test("allowlist: so /v1/previews/<id 20-40 a-z0-9>/p e abaixo e publico; /open, outros ids e variacoes seguem com login", () => {
	const yes = [`/v1/previews/${ID}/p`, `/v1/previews/${ID}/p/`, `/v1/previews/${ID}/p/${CAP}/assets/app.js`, `/v1/previews/${"a".repeat(20)}/p/x`, `/v1/previews/${"a".repeat(40)}/p/x`];
	for (const path of yes) {
		assert.equal(isPublicV1Request("GET", path), true, path);
		assert.equal(isPublicV1Request("POST", path), true, `${path} (POST)`);
	}
	const no = [
		`/v1/previews/${ID}/open`,
		`/v1/previews/${ID}`,
		`/v1/previews/${ID}/px`,
		`/v1/previews/${ID}/p-x/a`,
		`/v1/previews/${ID}/pp/a`,
		`/v1/previews/${ID.toUpperCase()}/p/a`,
		`/v1/previews/${"a".repeat(19)}/p/a`,
		`/v1/previews/${"a".repeat(41)}/p/a`,
		`/v1/previews/${ID}/open/p/a`,
		`/v1/previews/a/b/${ID}/p/a`,
		`/x/v1/previews/${ID}/p/a`,
		`/v1/previews//p/a`,
		`/v1/previews/${ID}%2fp/a`,
		`/v1/bots`,
	];
	for (const path of no) assert.equal(isPublicV1Request("GET", path), false, path);
});

test("requireUser: /p/ passa sem sessao do Atlas (o cap autentica); /open e o resto seguem 401", async () => {
	const h = await harness();
	const realGetSession = auth.api.getSession;
	auth.api.getSession = (async () => null) as unknown as typeof auth.api.getSession;
	try {
		const app = new Hono<AuthEnv>();
		app.use("/v1/*", requireUser);
		app.route("/", createPreviewBasicRoutes(h.service));
		app.get("/v1/previews/:id/open", (c) => c.json({ ok: true }));
		assert.equal((await app.request(`https://atlas.test${PREFIX}`)).status, 200);
		const noCap = await app.request(`https://atlas.test/v1/previews/${ID}/p/errado/`);
		assert.equal(noCap.status, 401);
		assert.match(await noCap.text(), /Link expirado/, "401 da prévia, não do requireUser");
		assert.equal((await app.request(`https://atlas.test/v1/previews/${ID}/open`)).status, 401);
		// O parser de URL normaliza `..` antes do roteamento: não dá para sair do prefixo para /open sem login.
		assert.equal((await app.request(`https://atlas.test${PREFIX}../../../open`)).status, 401);
	} finally {
		auth.api.getSession = realGetSession;
		h.close();
	}
});

test("websocket no modo basico: recusado (403) mesmo com o cap valido e Origin null; nada chega ao projeto", async () => {
	const h = await harness();
	const front = http.createServer();
	front.on("upgrade", createUpgradeDispatcher({ preview: h.service }));
	await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
	try {
		const port = (front.address() as AddressInfo).port;
		assert.equal(h.service.claimsUpgrade({ url: `${PREFIX}hmr`, headers: { host: "atlas.test" } } as http.IncomingMessage), true);
		assert.equal(h.service.claimsUpgrade({ url: "/v1/viewer/ws", headers: { host: "atlas.test" } } as http.IncomingMessage), false);
		const reply = await new Promise<string>((resolve) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				socket.write([`GET ${PREFIX}hmr HTTP/1.1`, "Host: atlas.test", "Connection: Upgrade", "Upgrade: websocket", "Origin: null", "Sec-WebSocket-Key: abc", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
			});
			let data = "";
			socket.on("data", (chunk) => (data += chunk));
			socket.on("close", () => resolve(data));
			setTimeout(() => socket.destroy(), 500);
		});
		assert.match(reply, /^HTTP\/1\.1 403/);
		assert.equal(h.seen.length, 0);
	} finally {
		front.close();
		front.closeAllConnections();
		h.close();
	}
});
