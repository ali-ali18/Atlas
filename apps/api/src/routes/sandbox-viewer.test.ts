import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const { createSandboxManager, loadSandboxConfig } = await import("@workspace/sandbox");
const { createSandboxRoutes } = await import("./sandbox.js");
const { createViewerUpgradeHandler, signViewerToken, verifyViewerToken, withViewerToken } = await import("./sandbox-viewer.js");
import type { AuthEnv } from "../middleware/auth.js";
import type { SandboxSessionResponse } from "@workspace/shared";

const SECRET = "viewer-secret";
const config = loadSandboxConfig({ SANDBOX_ENABLED: "false", SANDBOX_VIEWER_MODE: "proxy" });
const session: SandboxSessionResponse = {
	sessionId: "session-a",
	conversationId: "conversation-a",
	status: "running",
	viewerUrl: "/v1/sandbox/sessions/session-a/viewer/vnc.html?autoconnect=1&path=v1%2Fsandbox%2Fsessions%2Fsession-a%2Fviewer%2Fwebsockify",
	createdAt: new Date(0).toISOString(),
};

function listen(server: http.Server | net.Server): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function managerFor(owner: string, port: number) {
	return {
		...createSandboxManager(config, owner),
		getOwnedSessionMetadata: async (id: string) => (owner === "user-a" && id === "session-a" ? session : null),
		getSession: async (id: string) => (owner === "user-a" && id === "session-a" ? session : null),
		resolveViewerTarget: async (id: string) => (owner === "user-a" && id === "session-a" ? { host: "127.0.0.1", port, tls: false } : null),
	};
}

const ownedConversation = async (id: string, owner: string) => (id === "conversation-a" && owner === "user-a" ? { id } : null);

function appFor(userId: string, port: number) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		const now = new Date();
		c.set("session", { user: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "t", userId, token: "t", expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now } });
		await next();
	});
	app.route("/", createSandboxRoutes(config, { ownedConversation, managerForUser: (owner) => managerFor(owner, port), viewerSecret: SECRET }));
	return app;
}

test("token: valido, expirado, de outra sessao e adulterado", () => {
	const now = 1_000_000;
	const token = signViewerToken({ sessionId: "s1", userId: "u1" }, SECRET, now);
	assert.equal(verifyViewerToken(token, "s1", SECRET, now + 1000), "u1");
	assert.equal(verifyViewerToken(token, "s1", SECRET, now + 10 * 60_000 + 1), null);
	assert.equal(verifyViewerToken(token, "s2", SECRET, now + 1000), null);
	assert.equal(verifyViewerToken(token, "s1", "outro-segredo", now + 1000), null);
	const [payload, mac] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ s: "s1", u: "admin", e: now + 99_999_999 })).toString("base64url");
	assert.equal(verifyViewerToken(`${forged}.${mac}`, "s1", SECRET, now + 1000), null);
	assert.equal(verifyViewerToken(`${payload}.`, "s1", SECRET, now), null);
	assert.equal(verifyViewerToken(undefined, "s1", SECRET, now), null);
	assert.equal(verifyViewerToken("lixo", "s1", SECRET, now), null);
});

test("withViewerToken poe o token no path do websockify", () => {
	const url = withViewerToken(session.viewerUrl, "TKN");
	assert.equal(new URL(url, "http://x").searchParams.get("path"), "v1/sandbox/sessions/session-a/viewer/websockify?t=TKN");
	assert.equal(withViewerToken("http://localhost:7001/vnc.html", "TKN"), "http://localhost:7001/vnc.html");
});

test("HTTP: dono recebe assets do noVNC; outro usuario recebe 404 sem tocar o upstream", async () => {
	const seen: Array<{ url?: string; cookie?: string }> = [];
	const upstream = http.createServer((req, res) => {
		seen.push({ url: req.url, cookie: req.headers.cookie });
		res.setHeader("Content-Type", "text/html");
		res.end("<html>novnc</html>");
	});
	const port = await listen(upstream);
	try {
		const ok = await appFor("user-a", port).request("/v1/sandbox/sessions/session-a/viewer/vnc.html?autoconnect=1", { headers: { cookie: "session=secret" } });
		assert.equal(ok.status, 200);
		assert.equal(await ok.text(), "<html>novnc</html>");
		assert.deepEqual(seen, [{ url: "/vnc.html?autoconnect=1", cookie: undefined }]);

		const denied = await appFor("user-b", port).request("/v1/sandbox/sessions/session-a/viewer/vnc.html");
		assert.equal(denied.status, 404);
		assert.equal(seen.length, 1);

		const traversal = await appFor("user-a", port).request("/v1/sandbox/sessions/session-a/viewer/%2e%2e/etc");
		assert.equal(traversal.status, 404);
		assert.equal(seen.length, 1);
	} finally {
		upstream.close();
	}
});

test("HTTP: upstream fora do ar responde 502", async () => {
	const probe = net.createServer();
	const port = await listen(probe);
	probe.close();
	const res = await appFor("user-a", port).request("/v1/sandbox/sessions/session-a/viewer/vnc.html");
	assert.equal(res.status, 502);
});

test("API em modo proxy devolve viewerUrl relativa com token", async () => {
	const res = await appFor("user-a", 1).request("/v1/sandbox/sessions/session-a");
	const body = (await res.json()) as SandboxSessionResponse;
	const path = new URL(body.viewerUrl, "http://x").searchParams.get("path") ?? "";
	const token = path.split("?t=")[1];
	assert.equal(verifyViewerToken(token, "session-a", SECRET), "user-a");
});

test("buildViewerUrl direto continua igual", () => {
	const direct = loadSandboxConfig({ SANDBOX_ENABLED: "false", SANDBOX_VIEWER_HOST: "http://host" });
	assert.equal(direct.viewerMode, "direct");
});

// ---- WebSocket ---------------------------------------------------------

async function wsHarness(opts: { cookieUser?: string | null; now?: () => number } = {}) {
	// Upstream "websockify": responde 101 e faz eco.
	const requests: string[] = [];
	const upstream = net.createServer((sock) => {
		let buf = "";
		let upgraded = false;
		sock.on("data", (chunk) => {
			if (!upgraded) {
				buf += chunk.toString("latin1");
				if (!buf.includes("\r\n\r\n")) return;
				requests.push(buf.split("\r\n\r\n")[0]!);
				upgraded = true;
				sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
				return;
			}
			sock.write(chunk);
		});
		sock.on("error", () => undefined);
	});
	const upstreamPort = await listen(upstream);
	const handler = createViewerUpgradeHandler({
		secret: SECRET,
		managerForUser: (owner) => managerFor(owner, upstreamPort) as never,
		ownedConversation,
		userFromRequest: async () => opts.cookieUser ?? null,
		now: opts.now,
	});
	const front = http.createServer();
	front.on("upgrade", (req, socket, head) => void handler(req, socket, head));
	const frontPort = await listen(front);
	const connect = (path: string, headers: Record<string, string> = {}) =>
		new Promise<{ status: number; echo?: string }>((resolve) => {
			const req = http.request({ host: "127.0.0.1", port: frontPort, path, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "x", "Sec-WebSocket-Version": "13", ...headers } });
			req.on("upgrade", (_res, socket) => {
				socket.write("ping");
				socket.once("data", (d) => {
					socket.destroy();
					resolve({ status: 101, echo: d.toString() });
				});
			});
			req.on("response", (res) => {
				res.resume();
				resolve({ status: res.statusCode ?? 0 });
			});
			req.on("error", () => resolve({ status: 0 }));
			req.end();
		});
	return { connect, requests, close: () => { front.close(); upstream.close(); front.closeAllConnections(); } };
}

const WS = "/v1/sandbox/sessions/session-a/viewer/websockify";

test("WS: token valido faz upgrade e repassa bytes; token e cookie nao vazam ao upstream", async () => {
	const h = await wsHarness();
	try {
		const token = signViewerToken({ sessionId: "session-a", userId: "user-a" }, SECRET);
		const res = await h.connect(`${WS}?t=${token}&x=1`, { Cookie: "session=secret" });
		assert.deepEqual(res, { status: 101, echo: "ping" });
		assert.match(h.requests[0]!, /^GET \/websockify\?x=1 HTTP\/1\.1/);
		assert.doesNotMatch(h.requests[0]!, /secret|t=/i);
	} finally {
		h.close();
	}
});

test("WS: cookie de dono vale sem token", async () => {
	const h = await wsHarness({ cookieUser: "user-a" });
	try {
		assert.equal((await h.connect(WS)).status, 101);
	} finally {
		h.close();
	}
});

test("WS: sem token nem cookie, 401", async () => {
	const h = await wsHarness();
	try {
		assert.equal((await h.connect(WS)).status, 401);
		assert.equal(h.requests.length, 0);
	} finally {
		h.close();
	}
});

test("WS: token expirado, adulterado ou de outra sessao e recusado", async () => {
	const h = await wsHarness({ now: () => Date.now() + 11 * 60_000 });
	try {
		const expired = signViewerToken({ sessionId: "session-a", userId: "user-a" }, SECRET);
		assert.equal((await h.connect(`${WS}?t=${expired}`)).status, 401);
		const other = signViewerToken({ sessionId: "session-b", userId: "user-a" }, SECRET);
		assert.equal((await h.connect(`${WS}?t=${other}`)).status, 401);
		assert.equal(h.requests.length, 0);
	} finally {
		h.close();
	}
});

test("WS: token de outro usuario nao abre sessao alheia (ownership)", async () => {
	const h = await wsHarness();
	try {
		const token = signViewerToken({ sessionId: "session-a", userId: "user-b" }, SECRET);
		assert.equal((await h.connect(`${WS}?t=${token}`)).status, 404);
		assert.equal(h.requests.length, 0);
	} finally {
		h.close();
	}
});

test("WS: Origin de outro site e recusado", async () => {
	const h = await wsHarness({ cookieUser: "user-a" });
	try {
		assert.equal((await h.connect(WS, { Origin: "https://evil.example" })).status, 403);
	} finally {
		h.close();
	}
});

test("WS: caminho fora do websockify e recusado", async () => {
	const h = await wsHarness({ cookieUser: "user-a" });
	try {
		assert.equal((await h.connect("/v1/sandbox/sessions/session-a/viewer/vnc.html")).status, 404);
	} finally {
		h.close();
	}
});
