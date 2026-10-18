import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { requireUser } = await import("./auth.js");
const { auth } = await import("../auth.js");

const app = new Hono();
app.use("/v1/*", requireUser);
app.get("/v1/bots", (c) => c.json({ ok: true }));
app.post("/v1/hooks/github", (c) => c.json({ ok: true }));
app.post("/v1/internal/dev-jobs/callback", (c) => c.json({ ok: true }));
app.get("/v1/internal/dev-jobs/other", (c) => c.json({ ok: true }));
app.get("/v1/mcp/oauth/callback", (c) => c.json({ ok: true }));
app.post("/v1/mcp/oauth/callback", (c) => c.json({ ok: true }));
// Espelha apps/api/src/index.ts:97 — /health está FORA de /v1/*,
// então não passa pelo requireUser.
app.get("/health", (c) => c.json({ ok: true }));

const ownerEmail = process.env.ATLAS_OWNER_EMAIL ?? "owner@example.com";
const realGetSession = auth.api.getSession;

function stubSession(session: unknown): void {
  auth.api.getSession =
    (async () => session) as unknown as typeof auth.api.getSession;
}

function restoreSession(): void {
  auth.api.getSession = realGetSession;
}

test("private API refuses requests without a session", async () => {
	const response = await app.request("/v1/bots");
	assert.equal(response.status, 401);
});

test("callback de fim de job é público só no POST exato (autentica por HMAC na própria rota)", async () => {
  assert.equal((await app.request("/v1/internal/dev-jobs/callback", { method: "POST" })).status, 200);
  assert.equal((await app.request("/v1/internal/dev-jobs/other")).status, 401);
});

test("webhook POST (and the GET usage hint) bypass the session guard; connector OAuth callback now requires a session", async () => {
  assert.equal((await app.request("/v1/hooks/github", { method: "POST" })).status, 200);
  // GET /v1/hooks/:key é público (só devolve a dica 405) — mas nada além de 1 segmento.
  assert.equal((await app.request("/v1/hooks/github/extra")).status, 401);
  assert.equal((await app.request("/v1/hooks/github", { method: "DELETE" })).status, 401);
  assert.equal((await app.request("/v1/mcp/oauth/callback")).status, 401);
  assert.equal((await app.request("/v1/mcp/oauth/callback", { method: "POST" })).status, 401);
});

test("session with non-owner email is refused even when authenticated", async () => {
  stubSession({ user: { id: "intruder-id", email: "intruder@example.com" } });
  try {
    const response = await app.request("/v1/bots");
    assert.equal(response.status, 401);
  } finally {
    restoreSession();
  }
});

test("owner email session passes the guard", async () => {
  stubSession({ user: { id: "owner-id", email: ownerEmail } });
  try {
    const response = await app.request("/v1/bots");
    assert.equal(response.status, 200);
  } finally {
    restoreSession();
  }
});

test("/health is outside /v1/* so it never hits the session guard", async () => {
  // Sem sessão e sem stub: responde 200 porque a rota não usa requireUser,
  // igual ao comportamento real em apps/api/src/index.ts.
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
