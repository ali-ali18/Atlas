/**
 * Cache da sessão em cookie (5 min): o requireUser deixa de consultar o banco a cada requisição. Confere a
 * configuração, que sair apaga o cookie do cache e que o escopo continua vindo do `user.id` da sessão.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { auth } = await import("./auth.js");
const { requireUser, scopeFor } = await import("./middleware/auth.js");

test("cookie cache ligado por 5 minutos", () => {
	assert.deepEqual(auth.options.session?.cookieCache, { enabled: true, maxAge: 300 });
});

test("sair expira o cookie da sessão e o do cache", async () => {
	const response = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-out", {
			method: "POST",
			headers: { origin: "http://localhost:3000", "content-type": "application/json" },
			body: "{}",
		}),
	);
	const cookies = response.headers.getSetCookie();
	const expired = (name: string) => cookies.some((cookie) => cookie.includes(`${name}=`) && /Max-Age=0/i.test(cookie));
	assert.ok(expired("better-auth.session_token"), cookies.join("\n"));
	assert.ok(expired("better-auth.session_data"), cookies.join("\n"));
});

test("requireUser/scopeFor: o escopo é o user.id da sessão (venha do cookie ou do banco)", async () => {
	const realGetSession = auth.api.getSession;
	const ownerEmail = process.env.ATLAS_OWNER_EMAIL ?? "owner@example.com";
	auth.api.getSession = (async () => ({ user: { id: "user-1", email: ownerEmail }, session: { id: "s1", userId: "user-1" } })) as unknown as typeof auth.api.getSession;
	try {
		const app = new Hono<import("./middleware/auth.js").AuthEnv>();
		app.use("/v1/*", requireUser);
		app.get("/v1/me", (c) => c.json(scopeFor(c.get("session"))));
		const response = await app.request("/v1/me");
		assert.deepEqual(await response.json(), { userId: "user-1" });
	} finally {
		auth.api.getSession = realGetSession;
	}
});
