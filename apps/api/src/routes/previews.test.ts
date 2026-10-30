import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const {
	PREVIEW_AUTH_PATH,
	PREVIEW_COOKIE,
	createPreviewOpenRoutes,
	createPreviewService,
	createUpgradeDispatcher,
	loadPreviewConfig,
	previewConfigProblem,
	rewriteUpstreamSetCookie,
	signPreviewToken,
	stripPreviewCookie,
	verifyPreviewToken,
} = await import("./previews.js");
import type { DevSessionRecord } from "@workspace/db";
import type { AuthEnv } from "../middleware/auth.js";

const SECRET = "preview-secret";
const ID = "cmabc123def456ghi789jkl01";
const HOST = `${ID}.preview.test`;
const NOW = 1_800_000_000_000;
const config = { baseDomain: "preview.test", scheme: "https" as const, atlasUrl: "https://atlas.test", secret: SECRET };

function record(overrides: Partial<DevSessionRecord> & { port: number; expiresAt?: number }): DevSessionRecord {
	const { port, expiresAt, ...rest } = overrides;
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
		preview: { port, path: "/index.html", startedAt: new Date(NOW).toISOString(), expiresAt: new Date(expiresAt ?? NOW + 3_600_000).toISOString() },
		createdAt: new Date(0),
		updatedAt: new Date(0),
		lastActiveAt: new Date(0),
		...rest,
	};
}

function listen(server: http.Server | net.Server): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

type Seen = { headers: http.IncomingHttpHeaders; url: string; body: string };

/** Projeto "do usuário": devolve eco e tenta setar cookie com Domain. */
async function startUpstream(seen: Seen[]) {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({ headers: req.headers, url: req.url ?? "", body });
			if (req.url === "/redirect") {
				const self = (server.address() as AddressInfo).port;
				res.statusCode = 302;
				res.setHeader("Location", `http://127.0.0.1:${self}/dest?x=1#h`);
				res.setHeader("Content-Location", `http://localhost:${self}/c`);
				res.setHeader("Refresh", `0; url=http://0.0.0.0:${self}/r`);
				res.setHeader("Access-Control-Allow-Origin", `http://127.0.0.1:${self}`);
				res.end();
				return;
			}
			res.setHeader("Set-Cookie", ["theme=dark; Domain=preview.test; Path=/", `${PREVIEW_COOKIE}=evil; Path=/`]);
			res.setHeader("Content-Type", "text/plain");
			res.end(`ok ${req.method} ${req.url}`);
		});
	});
	server.on("upgrade", (req, socket) => {
		seen.push({ headers: req.headers, url: req.url ?? "", body: "upgrade" });
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello-from-upstream");
	});
	return { server, port: await listen(server) };
}

async function harness(options: { sessionFor?: (port: number) => DevSessionRecord | null; host?: string | null } = {}) {
	const seen: Seen[] = [];
	const upstream = await startUpstream(seen);
	const touches: string[] = [];
	const state = { now: NOW, session: options.sessionFor ? options.sessionFor(upstream.port) : record({ port: upstream.port }) };
	const service = createPreviewService({
		config,
		getSessionById: async (id) => (state.session && id === state.session.id ? state.session : null),
		getOwnedSession: async (id, userId) => (state.session && id === state.session.id && userId === state.session.userId ? state.session : null),
		resolveContainerHost: async () => (options.host === undefined ? "127.0.0.1" : options.host),
		touch: async (id) => void touches.push(id),
		now: () => state.now,
	});
	const front = serve({ fetch: async (request) => (await service.handleRequest(request)) ?? new Response("fell-through", { status: 418 }), port: 0, hostname: "127.0.0.1" }) as http.Server;
	front.on("upgrade", (req, socket, head) => {
		if (service.claimsUpgrade(req)) void service.handleUpgrade(req, socket, head);
		else socket.destroy();
	});
	await new Promise<void>((resolve) => (front.listening ? resolve() : front.once("listening", () => resolve())));
	const frontPort = (front.address() as AddressInfo).port;
	return {
		seen,
		touches,
		state,
		service,
		/** WebSocket que fica aberto; `closed` resolve quando o proxy o derruba. */
		openSocket: (headers: Record<string, string>) =>
			new Promise<{ socket: net.Socket; closed: Promise<void> }>((resolve) => {
				const socket = net.connect(frontPort, "127.0.0.1", () => {
					const lines = ["GET /hmr HTTP/1.1", `Host: ${HOST}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: abc", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
					socket.write(`${lines.join("\r\n")}\r\n\r\n`);
				});
				const closed = new Promise<void>((done) => socket.on("close", () => done()));
				socket.once("data", () => resolve({ socket, closed }));
			}),
		upstreamPort: upstream.port,
		get: (path: string, headers: Record<string, string> = {}, host = HOST) =>
			new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port: frontPort, path, method: "GET", agent: false, headers: { host, ...headers } }, (res) => {
					let body = "";
					res.on("data", (chunk) => (body += chunk));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
				});
				req.on("error", reject);
				req.end();
			}),
		upgrade: (headers: Record<string, string>, host = HOST) =>
			new Promise<string>((resolve) => {
				const socket = net.connect(frontPort, "127.0.0.1", () => {
					const lines = ["GET /hmr HTTP/1.1", `Host: ${host}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: abc", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
					socket.write(`${lines.join("\r\n")}\r\n\r\n`);
				});
				let data = "";
				socket.on("data", (chunk) => (data += chunk));
				socket.on("close", () => resolve(data));
				setTimeout(() => socket.destroy(), 300);
			}),
		close: () => {
			front.close();
			front.closeAllConnections?.();
			upstream.server.close();
			upstream.server.closeAllConnections();
		},
	};
}

const sessionCookie = (userId = "user-a", previewId = ID) => `${PREVIEW_COOKIE}=${signPreviewToken("session", { previewId, userId }, SECRET, 3_600_000, NOW)}`;

test("token: valido, expirado, de outra previa, adulterado e de outro tipo", () => {
	const token = signPreviewToken("open", { previewId: ID, userId: "u1" }, SECRET, 60_000, NOW);
	assert.equal(verifyPreviewToken("open", token, ID, SECRET, NOW + 1000), "u1");
	assert.equal(verifyPreviewToken("open", token, ID, SECRET, NOW + 60_001), null);
	assert.equal(verifyPreviewToken("open", token, "outraprevia", SECRET, NOW + 1000), null);
	assert.equal(verifyPreviewToken("open", token, ID, "outro", NOW + 1000), null);
	assert.equal(verifyPreviewToken("session", token, ID, SECRET, NOW + 1000), null, "token de entrada não vale como cookie");
	const [payload, mac] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ p: ID, u: "admin", e: NOW + 99_999_999 })).toString("base64url");
	assert.equal(verifyPreviewToken("open", `${forged}.${mac}`, ID, SECRET, NOW), null);
	assert.equal(verifyPreviewToken("open", `${payload}.${mac}.x`, ID, SECRET, NOW), null);
	assert.equal(verifyPreviewToken("open", null, ID, SECRET, NOW), null);
});

test("cookies: o nosso nao segue ao projeto e Set-Cookie perde o Domain", () => {
	assert.equal(stripPreviewCookie(`a=1; ${PREVIEW_COOKIE}=tok; b=2`), "a=1; b=2");
	assert.equal(stripPreviewCookie(`${PREVIEW_COOKIE}=tok`), undefined);
	assert.equal(rewriteUpstreamSetCookie("theme=dark; Domain=preview.test; Path=/"), "theme=dark; Path=/");
	assert.equal(rewriteUpstreamSetCookie(`${PREVIEW_COOKIE}=evil; Path=/`), null);
});

test("config: exige dominio, ATLAS_URL e segredo; esquema segue o ATLAS_URL", () => {
	assert.equal(loadPreviewConfig({ ATLAS_URL: "https://a.test", BETTER_AUTH_SECRET: "s" }), null);
	assert.equal(loadPreviewConfig({ ATLAS_PREVIEW_BASE_DOMAIN: "p.test", BETTER_AUTH_SECRET: "s" }), null);
	assert.deepEqual(loadPreviewConfig({ ATLAS_PREVIEW_BASE_DOMAIN: "*.P.test", ATLAS_URL: "https://a.test/", BETTER_AUTH_SECRET: "s" }), { baseDomain: "p.test", atlasUrl: "https://a.test", secret: "s", scheme: "https" });
	assert.equal(loadPreviewConfig({ ATLAS_PREVIEW_BASE_DOMAIN: "p.localhost:3001", ATLAS_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "s" })?.scheme, "http");
});

function openApp(userId: string, session: DevSessionRecord | null, cfg: typeof config | null = config, now = NOW) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		const date = new Date();
		c.set("session", { user: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true, createdAt: date, updatedAt: date }, session: { id: "t", userId, token: "t", expiresAt: date, createdAt: date, updatedAt: date } });
		await next();
	});
	app.route("/", createPreviewOpenRoutes({ config: cfg, getOwnedSession: async (id, owner) => (session && id === session.id && owner === session.userId ? session : null), now: () => now }));
	return app;
}

test("open: dono recebe redirect ao dominio da previa com token; outro usuario, vencida, parada e sem config dao 404", async () => {
	const session = record({ port: 5173 });
	const ok = await openApp("user-a", session).request(`/v1/previews/${ID}/open`);
	assert.equal(ok.status, 302);
	const location = new URL(ok.headers.get("location")!);
	assert.equal(location.origin, `https://${HOST}`);
	assert.equal(location.pathname, PREVIEW_AUTH_PATH);
	assert.equal(verifyPreviewToken("open", location.searchParams.get("t"), ID, SECRET, NOW), "user-a");
	assert.equal(ok.headers.get("cache-control"), "no-store");

	assert.equal((await openApp("user-b", session).request(`/v1/previews/${ID}/open`)).status, 404, "outro usuário");
	assert.equal((await openApp("user-a", session).request(`/v1/previews/outra/open`)).status, 404, "id inexistente");
	assert.equal((await openApp("user-a", record({ port: 5173, expiresAt: NOW - 1 })).request(`/v1/previews/${ID}/open`)).status, 404, "vencida");
	assert.equal((await openApp("user-a", record({ port: 5173, status: "STOPPED" })).request(`/v1/previews/${ID}/open`)).status, 404, "ambiente parado");
	assert.equal((await openApp("user-a", record({ port: 5173, preview: null })).request(`/v1/previews/${ID}/open`)).status, 404, "sem prévia");
	assert.equal((await openApp("user-a", session, null).request(`/v1/previews/${ID}/open`)).status, 404, "prévia não configurada");
});

test("auth: token de entrada vira cookie HttpOnly do host e redireciona ao caminho registrado", async () => {
	const h = await harness();
	try {
		const open = signPreviewToken("open", { previewId: ID, userId: "user-a" }, SECRET, 60_000, NOW);
		const res = await h.get(`${PREVIEW_AUTH_PATH}?t=${open}`);
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, "/index.html");
		const cookie = String(res.headers["set-cookie"]);
		assert.match(cookie, new RegExp(`^${PREVIEW_COOKIE}=`));
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /SameSite=Lax/);
		assert.match(cookie, /Secure/);
		assert.doesNotMatch(cookie, /Domain=/i);
		assert.match(cookie, /Max-Age=3600/);
		assert.equal(res.headers["referrer-policy"], "no-referrer");
		// O cookie emitido autentica a prévia.
		const value = cookie.split(";")[0]!;
		assert.equal((await h.get("/", { cookie: value })).status, 200);
	} finally {
		h.close();
	}
});

test("auth: token ausente, vencido, de outro usuario ou de outro tipo nao entra", async () => {
	const h = await harness();
	try {
		assert.equal((await h.get(PREVIEW_AUTH_PATH)).status, 401);
		const expired = signPreviewToken("open", { previewId: ID, userId: "user-a" }, SECRET, 1, NOW - 10_000);
		assert.equal((await h.get(`${PREVIEW_AUTH_PATH}?t=${expired}`)).status, 401);
		const session = signPreviewToken("session", { previewId: ID, userId: "user-a" }, SECRET, 60_000, NOW);
		assert.equal((await h.get(`${PREVIEW_AUTH_PATH}?t=${session}`)).status, 401);
		const stranger = signPreviewToken("open", { previewId: ID, userId: "user-b" }, SECRET, 60_000, NOW);
		assert.equal((await h.get(`${PREVIEW_AUTH_PATH}?t=${stranger}`)).status, 404, "assinatura válida, mas a sessão é de outro dono");
	} finally {
		h.close();
	}
});

test("proxy: caminho feliz leva a requisicao ao projeto sem credenciais do Atlas e com cabecalhos de seguranca", async () => {
	const h = await harness();
	try {
		const res = await h.get("/app.js?v=1", { cookie: `${sessionCookie()}; theme=light`, authorization: "Bearer segredo", origin: "https://x.test", referer: "https://x.test/", "x-forwarded-for": "9.9.9.9" });
		assert.equal(res.status, 200);
		assert.equal(res.body, "ok GET /app.js?v=1");
		const seen = h.seen[0]!;
		assert.equal(seen.headers.cookie, "theme=light", "só o cookie do app");
		assert.equal(seen.headers.authorization, undefined);
		assert.equal(seen.headers.origin, undefined);
		assert.equal(seen.headers.referer, undefined);
		assert.equal(seen.headers["x-forwarded-for"], undefined);
		assert.equal(seen.headers.host, `127.0.0.1:${h.upstreamPort}`);
		assert.equal(res.headers["referrer-policy"], "no-referrer");
		assert.match(String(res.headers["x-robots-tag"]), /noindex/);
		assert.equal(res.headers["x-content-type-options"], "nosniff");
		const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
		assert.deepEqual(cookies, ["theme=dark; Path=/"], "sem Domain e sem o nosso nome de cookie");
		assert.deepEqual(h.touches, [ID], "o uso mantém o container acordado");
	} finally {
		h.close();
	}
});

test("proxy: sem cookie, cookie adulterado ou vencido -> 401, e nada chega ao projeto", async () => {
	const h = await harness();
	try {
		assert.equal((await h.get("/")).status, 401);
		const good = sessionCookie();
		assert.equal((await h.get("/", { cookie: `${good}x` })).status, 401);
		const expired = `${PREVIEW_COOKIE}=${signPreviewToken("session", { previewId: ID, userId: "user-a" }, SECRET, 1, NOW - 10_000)}`;
		assert.equal((await h.get("/", { cookie: expired })).status, 401);
		const openAsCookie = `${PREVIEW_COOKIE}=${signPreviewToken("open", { previewId: ID, userId: "user-a" }, SECRET, 60_000, NOW)}`;
		assert.equal((await h.get("/", { cookie: openAsCookie })).status, 401);
		assert.equal(h.seen.length, 0);
	} finally {
		h.close();
	}
});

test("proxy: cookie de outro usuario ou de outra previa nao abre a previa do dono (404/401)", async () => {
	const h = await harness();
	try {
		assert.equal((await h.get("/", { cookie: sessionCookie("user-b") })).status, 404);
		assert.equal((await h.get("/", { cookie: sessionCookie("user-a", "cmzzz123def456ghi789jkl99") })).status, 401);
		assert.equal(h.seen.length, 0);
	} finally {
		h.close();
	}
});

test("proxy: previa vencida, ambiente parado, sem IP de container ou porta de controle -> 404", async () => {
	for (const options of [
		{ sessionFor: (port: number) => record({ port, expiresAt: NOW - 1 }) },
		{ sessionFor: (port: number) => record({ port, status: "STOPPED" }) },
		{ sessionFor: (port: number) => record({ port, preview: null }) },
		{ sessionFor: () => record({ port: 3090 }) },
		{ sessionFor: () => record({ port: 3128 }) },
		{ sessionFor: () => record({ port: 80 }) },
		{ sessionFor: () => null },
		{ host: null },
	]) {
		const h = await harness(options);
		try {
			assert.equal((await h.get("/", { cookie: sessionCookie() })).status, 404, JSON.stringify(Object.keys(options)));
			assert.equal(h.seen.length, 0);
		} finally {
			h.close();
		}
	}
});

test("proxy: Host que nao e de previa cai nas rotas normais", async () => {
	const h = await harness();
	try {
		for (const host of ["atlas.test", "preview.test", `${ID}.other.test`, "abc.preview.test", `x.${HOST}`]) {
			const res = await h.get("/", { cookie: sessionCookie() }, host);
			assert.equal(res.status, 418, host);
			assert.equal(res.body, "fell-through");
		}
		assert.equal(h.seen.length, 0);
	} finally {
		h.close();
	}
});

test("proxy: o destino nao muda por Host/headers da requisicao (SSRF)", async () => {
	const h = await harness();
	try {
		await h.get("/", { cookie: sessionCookie(), "x-forwarded-host": "169.254.169.254", "x-forwarded-port": "80" });
		assert.equal(h.seen.length, 1);
		// Só os nossos cabeçalhos seguem ao projeto: o host público, nunca o que o cliente mandou.
		assert.equal(h.seen[0]!.headers["x-forwarded-host"], HOST);
		assert.equal(h.seen[0]!.headers["x-forwarded-proto"], "https");
	} finally {
		h.close();
	}
});

test("websocket: com cookie valido encaminha ao projeto; sem cookie 401; origem de outro site 403; cookie de outro usuario 404", async () => {
	const h = await harness();
	try {
		const ok = await h.upgrade({ Cookie: `${sessionCookie()}; app=1`, Origin: `https://${HOST}` });
		assert.match(ok, /^HTTP\/1\.1 101/);
		assert.match(ok, /hello-from-upstream/);
		const forwarded = h.seen.find((item) => item.body === "upgrade")!;
		assert.equal(forwarded.headers.cookie, "app=1");
		assert.equal(forwarded.headers.origin, undefined);
		assert.equal(forwarded.headers.host, `127.0.0.1:${h.upstreamPort}`);

		assert.match(await h.upgrade({}), /^HTTP\/1\.1 401/);
		assert.match(await h.upgrade({ Cookie: sessionCookie(), Origin: "https://evil.test" }), /^HTTP\/1\.1 403/);
		assert.match(await h.upgrade({ Cookie: sessionCookie("user-b") }), /^HTTP\/1\.1 404/);
		assert.equal(h.seen.filter((item) => item.body === "upgrade").length, 1);
	} finally {
		h.close();
	}
});


test("redirect: Location, Content-Location, Refresh e ACAO internos viram a origem publica", async () => {
	const h = await harness();
	try {
		const res = await h.get("/redirect", { cookie: sessionCookie() });
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, `https://${HOST}/dest?x=1#h`);
		assert.equal(res.headers["content-location"], `https://${HOST}/c`);
		assert.equal(res.headers.refresh, `0; url=https://${HOST}/r`);
		assert.equal(res.headers["access-control-allow-origin"], `https://${HOST}`);
		assert.doesNotMatch(JSON.stringify(res.headers), /127\.0\.0\.1|localhost|0\.0\.0\.0/);
	} finally {
		h.close();
	}
});

test("redirect: destino externo e caminho relativo passam como vieram", async () => {
	const { rewriteToPublicOrigin } = await import("./previews.js");
	assert.equal(rewriteToPublicOrigin("https://example.org/x", "172.18.0.9", "https://p.test"), "https://example.org/x");
	assert.equal(rewriteToPublicOrigin("/local", "172.18.0.9", "https://p.test"), "/local");
	assert.equal(rewriteToPublicOrigin("http://172.18.0.9:5173/a?b=1", "172.18.0.9", "https://p.test"), "https://p.test/a?b=1");
});

test("config: dominio da previa igual, pai ou no mesmo site do Atlas deixa o recurso desligado (com escape hatch)", () => {
	const base = { BETTER_AUTH_SECRET: "s", ATLAS_URL: "https://atlas.example.com" };
	for (const domain of ["atlas.example.com", "example.com", "preview.example.com"]) {
		assert.equal(loadPreviewConfig({ ...base, ATLAS_PREVIEW_BASE_DOMAIN: domain }), null, domain);
		assert.match(previewConfigProblem({ ...base, ATLAS_PREVIEW_BASE_DOMAIN: domain }) ?? "", /domínio/, domain);
	}
	assert.notEqual(loadPreviewConfig({ ...base, ATLAS_PREVIEW_BASE_DOMAIN: "previews.example.net" }), null);
	assert.equal(previewConfigProblem({ ...base, ATLAS_PREVIEW_BASE_DOMAIN: "previews.example.net" }), null);
	assert.notEqual(loadPreviewConfig({ ...base, ATLAS_PREVIEW_BASE_DOMAIN: "preview.example.com", ATLAS_PREVIEW_ALLOW_SAME_SITE: "1" }), null);
	assert.equal(previewConfigProblem({ BETTER_AUTH_SECRET: "s" }), null, "sem variável: nada a avisar");
});

test("token de entrada e de uso unico: a segunda troca e recusada", async () => {
	const h = await harness();
	try {
		const open = signPreviewToken("open", { previewId: ID, userId: "user-a" }, SECRET, 30_000, NOW);
		assert.equal((await h.get(`${PREVIEW_AUTH_PATH}?t=${open}`)).status, 302);
		assert.equal((await h.get(`${PREVIEW_AUTH_PATH}?t=${open}`)).status, 401);
	} finally {
		h.close();
	}
});

test("cookie plantado com o mesmo nome (cookie tossing) nao esconde o legitimo", async () => {
	const h = await harness();
	try {
		const good = sessionCookie();
		const junk = `${PREVIEW_COOKIE}=lixo.lixo`;
		assert.equal((await h.get("/", { cookie: `${junk}; ${good}` })).status, 200);
		assert.equal((await h.get("/", { cookie: `${good}; ${junk}` })).status, 200);
		assert.equal((await h.get("/", { cookie: `${junk}; ${junk}` })).status, 401);
	} finally {
		h.close();
	}
});

test("cache de destino: vencimento conferido a cada requisicao, invalidate vale na hora e 404 nao fica em cache", async () => {
	const h = await harness({ sessionFor: (port) => record({ port, expiresAt: NOW + 1000 }) });
	try {
		const cookie = { cookie: sessionCookie() };
		assert.equal((await h.get("/", cookie)).status, 200);
		h.state.now = NOW + 2000; // dentro dos 5 s do cache, mas a prévia já venceu
		assert.equal((await h.get("/", cookie)).status, 404);
		h.state.now = NOW;
		assert.equal((await h.get("/", cookie)).status, 200, "sem cache negativo");
		const stopped = h.state.session;
		h.state.session = record({ port: stopped!.preview!.port, preview: null });
		assert.equal((await h.get("/", cookie)).status, 200, "ainda no cache de 5 s");
		h.service.invalidate(ID);
		assert.equal((await h.get("/", cookie)).status, 404);
	} finally {
		h.close();
	}
});

test("websocket aberto: cai ao vencer a previa e quando ela e encerrada", async () => {
	for (const how of ["expiry", "stop"] as const) {
		const h = await harness();
		try {
			const ws = await h.openSocket({ Cookie: sessionCookie(), Origin: `https://${HOST}` });
			if (how === "expiry") h.state.now = NOW + 3_600_001;
			else h.state.session = record({ port: h.state.session!.preview!.port, preview: null });
			await h.service.sweep();
			await Promise.race([ws.closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`websocket não fechou (${how})`)), 3000))]);
		} finally {
			h.close();
		}
	}
});

test("websocket aberto: cookie vencido tambem derruba na revalidacao", async () => {
	const h = await harness();
	try {
		const short = `${PREVIEW_COOKIE}=${signPreviewToken("session", { previewId: ID, userId: "user-a" }, SECRET, 1000, NOW)}`;
		const ws = await h.openSocket({ Cookie: short });
		h.state.now = NOW + 1500;
		await h.service.sweep();
		await Promise.race([ws.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("não fechou")), 3000))]);
	} finally {
		h.close();
	}
});

test("upgrade sem viewer e fora do host da previa: 404 limpo, sem calar o socket", () => {
	const written: string[] = [];
	let destroyed = false;
	const socket = { writable: true, write: (chunk: string) => void written.push(chunk), destroy: () => void (destroyed = true) };
	const dispatch = createUpgradeDispatcher({ preview: { claimsUpgrade: () => false, handleUpgrade: async () => undefined } });
	dispatch({ headers: { host: "atlas.test" } } as never, socket as never, Buffer.alloc(0));
	assert.match(written.join(""), /^HTTP\/1\.1 404/);
	assert.equal(destroyed, true);
	// Com viewer, quem trata é o viewer.
	let viewerCalled = false;
	createUpgradeDispatcher({ preview: { claimsUpgrade: () => false, handleUpgrade: async () => undefined }, viewer: () => void (viewerCalled = true) })({} as never, socket as never, Buffer.alloc(0));
	assert.equal(viewerCalled, true);
});
