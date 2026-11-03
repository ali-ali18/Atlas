import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { createMcpRoutes } = await import("./mcp.js");
import type { AuthEnv } from "../middleware/auth.js";

function app() {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: "user-a" }, session: { id: "sess-a" } } as unknown as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createMcpRoutes({ handoff: { mint: async () => { throw new Error("não deveria gerar link"); } } }));
	return outer;
}

const post = (path: string, body: unknown) => app().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /v1/mcp/connections com client inválido: 400 listando o aceito, antes de qualquer efeito", async () => {
	for (const client of ["web", "Mobile", 1, null, true]) {
		const res = await post("/v1/mcp/connections", { catalogId: "github", client });
		assert.equal(res.status, 400, String(client));
		assert.match(((await res.json()) as { error: string }).error, /mobile/);
	}
});

test("POST /v1/mcp/connections/:id/reauth com client inválido: 400", async () => {
	const res = await post("/v1/mcp/connections/abc/reauth", { client: "ios" });
	assert.equal(res.status, 400);
	assert.match(((await res.json()) as { error: string }).error, /mobile/);
});
