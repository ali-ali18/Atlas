import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const { createSandboxManager, loadSandboxConfig } = await import("@workspace/sandbox");
const { createSandboxRoutes } = await import("./sandbox.js");
import type { AuthEnv } from "../middleware/auth.js";
import type { SandboxSessionResponse } from "@workspace/shared";

const config = loadSandboxConfig({ SANDBOX_ENABLED: "false" });
const session: SandboxSessionResponse = { sessionId: "session-a", conversationId: "conversation-a", status: "running", viewerUrl: "http://localhost:7001/vnc.html", createdAt: new Date(0).toISOString() };
function appFor(userId: string, effects: string[], stop: () => Promise<boolean> = async () => { effects.push("stop"); return true; }) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		const now = new Date();
		c.set("session", { user: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "test", userId, token: "test", expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now } });
		await next();
	});
	app.route("/", createSandboxRoutes(config, {
		ownedConversation: async (id, owner) => id === "conversation-a" && owner === "user-a" ? { id } : null,
		managerForUser: (owner) => ({
			...createSandboxManager(config, owner),
			getSession: async (id) => owner === "user-a" && id === session.sessionId ? session : null,
			getOwnedSessionMetadata: async (id) => owner === "user-a" && id === session.sessionId ? session : null,
			getSessionForConversation: async () => { effects.push("lookup"); return session; },
			resolveSession: async () => { effects.push("create"); return session; },
			destroySession: async () => { effects.push("destroy"); return true; },
			stopSession: stop,
			clearBrowserProfile: async (conversationId) => { effects.push(`clear:${conversationId}`); return { cleared: true, removedContainers: 1 }; },
			execScreenshot: async () => { effects.push("screenshot"); return Buffer.from([1, 2]); },
			execClick: async () => { effects.push("click"); return { ok: true }; },
		}),
	}));
	return app;
}

test("outro dono não acessa viewer, captura, controles ou exclusão", async () => {
	const effects: string[] = [];
	const app = appFor("user-b", effects);
	for (const [path, init] of [
		["/v1/sandbox/sessions/session-a", undefined],
		["/v1/sandbox/sessions/session-a/screenshot", undefined],
		["/v1/sandbox/sessions/session-a/screen", undefined],
		["/v1/sandbox/sessions/session-a/navigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"url":"https://example.test"}' }],
		["/v1/sandbox/sessions/session-a/type", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"teste"}' }],
		["/v1/sandbox/sessions/session-a/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"combo":"Return"}' }],
		["/v1/sandbox/sessions/session-a/scroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"deltaY":100}' }],
		["/v1/sandbox/sessions/session-a/click", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"x":1,"y":1}' }],
		["/v1/sandbox/sessions/session-a", { method: "DELETE" }],
		["/v1/sandbox/sessions/session-a/stop", { method: "POST" }],
	] as const) {
		const result = await app.request(path, init);
		assert.equal(result.status, 404);
		assert.doesNotMatch(await result.text(), /vnc|7001/);
	}
	assert.deepEqual(effects, []);
});

test("conversa alheia não permite procurar nem criar sandbox", async () => {
	const effects: string[] = [];
	const app = appFor("user-b", effects);
	assert.equal((await app.request("/v1/sandbox/sessions?conversationId=conversation-a")).status, 404);
	assert.equal((await app.request("/v1/sandbox/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"conversationId":"conversation-a"}' })).status, 404);
	assert.deepEqual(effects, []);
});

test("dono mantém criação, viewer, captura, clique e exclusão", async () => {
	const effects: string[] = [];
	const app = appFor("user-a", effects);
	assert.equal((await app.request("/v1/sandbox/sessions?conversationId=conversation-a")).status, 200);
	assert.equal((await app.request("/v1/sandbox/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"conversationId":"conversation-a"}' })).status, 201);
	assert.equal((await app.request("/v1/sandbox/sessions/session-a")).status, 200);
	assert.equal((await app.request("/v1/sandbox/sessions/session-a/screenshot")).status, 200);
	assert.equal((await app.request("/v1/sandbox/sessions/session-a/click", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"x":1,"y":1}' })).status, 200);
	assert.equal((await app.request("/v1/sandbox/sessions/session-a/stop", { method: "POST" })).status, 200);
	assert.equal((await app.request("/v1/sandbox/sessions/session-a", { method: "DELETE" })).status, 200);
	assert.deepEqual(effects, ["lookup", "create", "screenshot", "click", "stop", "destroy"]);
});

test("limpar sessão do navegador exige dono da conversa e conversationId", async () => {
	const effects: string[] = [];
	const other = appFor("user-b", effects);
	assert.equal((await other.request("/v1/sandbox/browser-profile?conversationId=conversation-a", { method: "DELETE" })).status, 404);
	assert.deepEqual(effects, []);
	const owner = appFor("user-a", effects);
	assert.equal((await owner.request("/v1/sandbox/browser-profile", { method: "DELETE" })).status, 400);
	const ok = await owner.request("/v1/sandbox/browser-profile?conversationId=conversation-a", { method: "DELETE" });
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { ok: true, cleared: true, removedContainers: 1 });
	assert.deepEqual(effects, ["clear:conversation-a"]);
});

test("parar: VM já parada é sucesso, sessão inexistente é 404 e erro de Docker é 500 (nunca um sucesso falso)", async () => {
	const effects: string[] = [];
	const stopRequest = (stop: () => Promise<boolean>) => appFor("user-a", effects, stop).request("/v1/sandbox/sessions/session-a/stop", { method: "POST" });
	// O manager real devolve true para container já parado (Docker 304); false só para sessão inexistente ou alheia.
	assert.equal((await stopRequest(async () => true)).status, 200);
	assert.equal((await stopRequest(async () => false)).status, 404);
	const failed = await stopRequest(async () => { throw new Error("docker daemon error"); });
	assert.equal(failed.status, 500);
	assert.doesNotMatch(await failed.text(), /daemon/);
});
