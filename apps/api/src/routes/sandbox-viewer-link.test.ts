import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const { createSandboxManager, loadSandboxConfig } = await import("@workspace/sandbox");
const { createSandboxRoutes } = await import("./sandbox.js");
const { readViewerToken, signViewerToken, safeViewerRest, verifyViewerToken } = await import("./sandbox-viewer.js");
const { isPublicV1Request, requireUser } = await import("../middleware/auth.js");
const { auth } = await import("../auth.js");
import type { AuthEnv } from "../middleware/auth.js";
import type { SandboxSessionResponse } from "@workspace/shared";

const SECRET = "viewer-secret";
const proxyConfig = loadSandboxConfig({ SANDBOX_ENABLED: "false", SANDBOX_VIEWER_MODE: "proxy" });
const directConfig = loadSandboxConfig({ SANDBOX_ENABLED: "false", SANDBOX_VIEWER_MODE: "direct" });
const session: SandboxSessionResponse = {
	sessionId: "session-a",
	conversationId: "conversation-a",
	status: "running",
	viewerUrl: "/v1/sandbox/sessions/session-a/viewer/vnc.html",
	createdAt: new Date(0).toISOString(),
};

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

// `ownerOf` permite simular a sessão trocada de dono depois de emitido o token.
function managerFor(owner: string, port: number, ownerOf: () => string) {
	const mine = (id: string) => owner === ownerOf() && id === "session-a";
	return {
		...createSandboxManager(proxyConfig, owner),
		getOwnedSessionMetadata: async (id: string) => (mine(id) ? session : null),
		resolveViewerTarget: async (id: string) => (mine(id) ? { host: "127.0.0.1", port, tls: false } : null),
	};
}

function build(opts: { userId?: string; port: number; config?: typeof proxyConfig; ownerOf?: () => string; convOwner?: () => string; withAuth?: boolean }) {
	const ownerOf = opts.ownerOf ?? (() => "user-a");
	const convOwner = opts.convOwner ?? (() => "user-a");
	const app = new Hono<AuthEnv>();
	if (opts.withAuth) app.use("/v1/*", requireUser);
	else if (opts.userId) {
		app.use("*", async (c, next) => {
			const now = new Date();
			const userId = opts.userId!;
			c.set("session", { user: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "t", userId, token: "t", expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now } });
			await next();
		});
	}
	app.route("/", createSandboxRoutes(opts.config ?? proxyConfig, {
		ownedConversation: async (id: string, owner: string) => (id === "conversation-a" && owner === convOwner() ? { id } : null),
		managerForUser: (owner: string) => managerFor(owner, opts.port, ownerOf),
		viewerSecret: SECRET,
	} as never));
	return app;
}

function captureConsole() {
	const lines: string[] = [];
	const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
	for (const k of Object.keys(originals) as Array<keyof typeof originals>) console[k] = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
	return { lines, restore: () => Object.assign(console, originals) };
}

test("viewer-link: dono recebe url relativa com token no caminho e no path do websocket", async () => {
	const res = await build({ userId: "user-a", port: 1 }).request("/v1/sandbox/sessions/session-a/viewer-link");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "private, no-store");
	const { url } = (await res.json()) as { url: string };
	const parsed = new URL(url, "http://x");
	const m = /^\/v1\/sandbox\/vt\/([^/]+)\/vnc\.html$/.exec(parsed.pathname);
	assert.ok(m, url);
	const claims = readViewerToken(m![1], SECRET);
	assert.deepEqual(claims, { sessionId: "session-a", userId: "user-a" });
	assert.equal(parsed.searchParams.get("autoconnect"), "1");
	assert.equal(parsed.searchParams.get("reconnect"), "true");
	assert.equal(parsed.searchParams.get("resize"), "scale");
	const wsPath = parsed.searchParams.get("path")!;
	const wsMatch = /^v1\/sandbox\/sessions\/session-a\/viewer\/websockify\?t=(.+)$/.exec(wsPath);
	assert.ok(wsMatch, wsPath);
	assert.notEqual(wsMatch![1], m![1]);
	// Cada token só serve ao seu propósito.
	assert.equal(verifyViewerToken(wsMatch![1], "session-a", SECRET), "user-a");
	assert.equal(verifyViewerToken(m![1], "session-a", SECRET), null);
	assert.equal(readViewerToken(wsMatch![1], SECRET), null);
});

test("viewer-link: usuario B recebe 404 na sessao do A", async () => {
	const res = await build({ userId: "user-b", port: 1 }).request("/v1/sandbox/sessions/session-a/viewer-link");
	assert.equal(res.status, 404);
	assert.doesNotMatch(await res.text(), /vt\//);
});

test("viewer-link: modo direct ou sem segredo respondem 409", async () => {
	const direct = await build({ userId: "user-a", port: 1, config: directConfig }).request("/v1/sandbox/sessions/session-a/viewer-link");
	assert.equal(direct.status, 409);
	assert.deepEqual(await direct.json(), { error: "Viewer link unavailable" });
	const saved = process.env.BETTER_AUTH_SECRET;
	delete process.env.BETTER_AUTH_SECRET;
	try {
		const app = new Hono<AuthEnv>();
		app.use("*", async (c, next) => { c.set("session", { user: { id: "user-a" } } as never); await next(); });
		app.route("/", createSandboxRoutes(proxyConfig, { ownedConversation: async () => ({}), managerForUser: (o: string) => managerFor(o, 1, () => "user-a") } as never));
		const res = await app.request("/v1/sandbox/sessions/session-a/viewer-link");
		assert.equal(res.status, 409);
	} finally {
		process.env.BETTER_AUTH_SECRET = saved;
	}
});

test("vt: token valido chama o proxy com o caminho certo e cabecalhos de seguranca", async () => {
	const seen: Array<{ url?: string; cookie?: string; auth?: string }> = [];
	const upstream = http.createServer((req, res) => {
		seen.push({ url: req.url, cookie: req.headers.cookie, auth: req.headers.authorization });
		res.setHeader("Content-Type", "text/html");
		res.setHeader("Set-Cookie", "evil=1; Path=/");
		res.setHeader("Content-Security-Policy", "sandbox allow-same-origin allow-scripts");
		res.setHeader("Content-Security-Policy-Report-Only", "default-src *");
		res.setHeader("X-Frame-Options", "ALLOWALL");
		res.end("<html>novnc</html>");
	});
	const port = await listen(upstream);
	try {
		const app = build({ port });
		const token = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
		const res = await app.request(`/v1/sandbox/vt/${token}/vnc.html?autoconnect=1`, { headers: { cookie: "x=y", authorization: "Bearer z" } });
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "<html>novnc</html>");
		assert.deepEqual(seen, [{ url: "/vnc.html?autoconnect=1", cookie: undefined, auth: undefined }]);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		assert.equal(res.headers.get("cache-control"), "private, no-store");
		assert.equal(res.headers.get("referrer-policy"), "no-referrer");
		const csp = res.headers.get("content-security-policy") ?? "";
		assert.equal(csp, "sandbox allow-scripts; frame-ancestors 'none'");
		assert.doesNotMatch(csp, /allow-same-origin/);
		assert.equal(res.headers.get("set-cookie"), null);
		assert.equal(res.headers.get("content-security-policy-report-only"), null);
		assert.equal(res.headers.get("x-frame-options"), null);
		const asset = await app.request(`/v1/sandbox/vt/${token}/app/ui.js`, { method: "HEAD" });
		assert.equal(asset.status, 200);
		assert.equal(seen[1]?.url, "/app/ui.js");
	} finally {
		upstream.close();
	}
});

test("vt: token adulterado, expirado ou de outro formato -> 401 sem tocar o upstream", async () => {
	let hits = 0;
	const upstream = http.createServer((_req, res) => { hits++; res.end("x"); });
	const port = await listen(upstream);
	try {
		const app = build({ port });
		const ok = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
		const expired = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET, Date.now() - 11 * 60_000);
		const wrongSecret = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, "outro");
		const [, mac] = ok.split(".");
		const forged = `${Buffer.from(JSON.stringify({ s: "session-a", u: "user-b", e: Date.now() + 1e9 })).toString("base64url")}.${mac}`;
		for (const t of [expired, wrongSecret, forged, "lixo", "a.b.c", `${ok}x`, "%00.%00"]) {
			const res = await app.request(`/v1/sandbox/vt/${t}/vnc.html`);
			assert.equal(res.status, 401, t);
			assert.deepEqual(await res.json(), { error: "Unauthorized" });
		}
		assert.equal(hits, 0);
	} finally {
		upstream.close();
	}
});

test("vt: posse revalidada com o userId do token (troca de dono, conversa de outro, token forjado de B)", async () => {
	let hits = 0;
	const upstream = http.createServer((_req, res) => { hits++; res.end("x"); });
	const port = await listen(upstream);
	try {
		const tokenA = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
		let owner = "user-a";
		const swapped = build({ port, ownerOf: () => owner });
		assert.equal((await swapped.request(`/v1/sandbox/vt/${tokenA}/vnc.html`)).status, 200);
		owner = "user-b";
		assert.equal((await swapped.request(`/v1/sandbox/vt/${tokenA}/vnc.html`)).status, 404);

		let conv = "user-a";
		const convApp = build({ port, convOwner: () => conv });
		conv = "user-z";
		assert.equal((await convApp.request(`/v1/sandbox/vt/${tokenA}/vnc.html`)).status, 404);

		// Token legítimo de B apontando para o id do A: a posse com userId de B falha.
		const tokenB = signViewerToken({ sessionId: "session-a", userId: "user-b", purpose: "vt" }, SECRET);
		const res = await build({ port }).request(`/v1/sandbox/vt/${tokenB}/vnc.html`);
		assert.equal(res.status, 404);
		assert.equal(hits, 1);
	} finally {
		upstream.close();
	}
});

test("vt: caminho com .. (cru ou codificado) -> 404", async () => {
	let hits = 0;
	const upstream = http.createServer((_req, res) => { hits++; res.end("x"); });
	const port = await listen(upstream);
	try {
		const app = build({ port });
		const token = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
		for (const p of ["a%2fb", "a%5Cb", "a%00b", "a%zz"]) {
			const res = await app.request(`/v1/sandbox/vt/${token}/${p}`);
			assert.equal(res.status, 404, p);
		}
		// `..` (cru ou %2e%2e) o próprio parser de URL já colapsa antes da rota (o token vira outro segmento): nunca chega a 200.
		const raw = await app.request(`/v1/sandbox/vt/${token}/../etc/passwd`);
		assert.notEqual(raw.status, 200);
		assert.equal(hits, 0);
	} finally {
		upstream.close();
	}
	assert.equal(safeViewerRest("app/ui.js"), "app/ui.js");
	for (const p of ["a/../b", "%2e%2e/x", "a/%2E%2E/b", "a/%2e/b", "./x"]) assert.equal(safeViewerRest(p), null, p);
	assert.equal(safeViewerRest("../x"), null);
});

test("vt: modo direct nao serve (401), mesmo com token valido", async () => {
	const token = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
	const res = await build({ port: 1, config: directConfig }).request(`/v1/sandbox/vt/${token}/vnc.html`);
	assert.equal(res.status, 401);
});

test("vt: com requireUser real, so o caminho do token passa sem sessao; o viewer por id segue exigindo login", async () => {
	const upstream = http.createServer((_req, res) => { res.end("ok"); });
	const port = await listen(upstream);
	const realGetSession = auth.api.getSession;
	auth.api.getSession = (async () => null) as unknown as typeof auth.api.getSession;
	try {
		const app = build({ port, withAuth: true });
		const token = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
		assert.equal((await app.request(`/v1/sandbox/vt/${token}/vnc.html`)).status, 200);
		assert.equal((await app.request("/v1/sandbox/sessions/session-a/viewer/vnc.html")).status, 401);
		assert.equal((await app.request("/v1/sandbox/sessions/session-a/viewer-link")).status, 401);
		assert.equal((await app.request("/v1/sandbox/sessions")).status, 401);
		assert.equal((await app.request(`/v1/sandbox/vt/${token}/vnc.html`, { method: "POST" })).status, 401);
	} finally {
		auth.api.getSession = realGetSession;
		upstream.close();
	}
});

test("isPublicV1Request: so GET/HEAD no padrao /v1/sandbox/vt/<b64>.<b64>/", () => {
	const t = "eyJzIjoiYSJ9.abc_DEF-123";
	assert.equal(isPublicV1Request("GET", `/v1/sandbox/vt/${t}/vnc.html`), true);
	assert.equal(isPublicV1Request("HEAD", `/v1/sandbox/vt/${t}/app/ui.js`), true);
	for (const [m, p] of [
		["POST", `/v1/sandbox/vt/${t}/vnc.html`],
		["PUT", `/v1/sandbox/vt/${t}/vnc.html`],
		["DELETE", `/v1/sandbox/vt/${t}/vnc.html`],
		["GET", "/v1/sandbox/vt/"],
		["GET", "/v1/sandbox/vt//vnc.html"],
		["GET", `/v1/sandbox/vt/${t}`],
		["GET", "/v1/sandbox/vt/semponto/vnc.html"],
		["GET", "/v1/sandbox/vt/a.b.c/vnc.html"],
		["GET", "/v1/sandbox/vt/a%2e.b/vnc.html"],
		["GET", `/x/v1/sandbox/vt/${t}/vnc.html`],
		["GET", "/v1/sandbox/sessions/x/viewer/vnc.html"],
		["GET", "/v1/sandbox/sessions/x/viewer-link"],
		["GET", "/v1/sandbox/sessions"],
		["POST", "/v1/sandbox/sessions"],
	] as const) assert.equal(isPublicV1Request(m, p), false, `${m} ${p}`);
});

test("o token do caminho nunca aparece em console.*", async () => {
	const upstream = http.createServer((req, res) => { if (req.url?.includes("boom")) req.destroy(); else res.end("ok"); });
	const port = await listen(upstream);
	const token = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
	const bad = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, "outro");
	const cap = captureConsole();
	let failStatus = 0;
	let failBody = "";
	try {
		const app = build({ port });
		await app.request(`/v1/sandbox/vt/${token}/vnc.html`);
		await app.request(`/v1/sandbox/vt/${token}/boom`);
		await app.request(`/v1/sandbox/vt/${token}/../x`);
		await app.request(`/v1/sandbox/vt/${bad}/vnc.html`);
		await build({ userId: "user-a", port }).request("/v1/sandbox/sessions/session-a/viewer-link");
		const failing = new Hono<AuthEnv>();
		failing.route("/", createSandboxRoutes(proxyConfig, {
			ownedConversation: async () => ({}),
			managerForUser: (o: string) => ({ ...managerFor(o, port, () => "user-a"), resolveViewerTarget: async () => { throw new Error(`falhou ${token}`); } }),
			viewerSecret: SECRET,
		} as never));
		const res = await failing.request(`/v1/sandbox/vt/${token}/vnc.html`);
		failStatus = res.status;
		failBody = await res.text();
	} finally {
		cap.restore();
		upstream.close();
	}
	assert.equal(failStatus, 502);
	assert.ok(!failBody.includes(token.split(".")[1]!));
	for (const line of cap.lines) {
		assert.ok(!line.includes(token.split(".")[0]!) && !line.includes(token.split(".")[1]!), line);
		assert.ok(!line.includes(bad.split(".")[1]!), line);
	}
});

test("proposito do token: ws nao abre vt, vt nao abre ws e token sem p e recusado", async () => {
	const ws = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "ws" }, SECRET);
	const vt = signViewerToken({ sessionId: "session-a", userId: "user-a", purpose: "vt" }, SECRET);
	const legacy = (() => {
		const payload = Buffer.from(JSON.stringify({ s: "session-a", u: "user-a", e: Date.now() + 60_000 })).toString("base64url");
		return `${payload}.${createHmac("sha256", `atlas-sandbox-viewer:${SECRET}`).update(payload).digest("base64url")}`;
	})();
	assert.equal(readViewerToken(ws, SECRET), null);
	assert.equal(verifyViewerToken(vt, "session-a", SECRET), null);
	assert.equal(readViewerToken(legacy, SECRET), null);
	assert.equal(verifyViewerToken(legacy, "session-a", SECRET), null);
	assert.notEqual(readViewerToken(vt, SECRET), null);
	const res = await build({ port: 1 }).request(`/v1/sandbox/vt/${ws}/vnc.html`);
	assert.equal(res.status, 401);
});
