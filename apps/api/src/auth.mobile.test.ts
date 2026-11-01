/**
 * Login do app mobile: código por e-mail (emailOTP), sessão por cookie (plugin expo) e origens confiáveis.
 * Banco em memória e e-mail capturado: nada de rede nem Postgres.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { memoryAdapter } from "better-auth/adapters/memory";

const OWNER = "owner@example.test";
process.env.ATLAS_OWNER_EMAIL = OWNER;
process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret";
process.env.ATLAS_URL = "http://localhost:3000";
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-secret";

const { createAuth, buildTrustedOrigins, EMAIL_OTP_ALLOWED_ATTEMPTS } = await import("./auth.js");
const { createRequireUser, scopeFor } = await import("./middleware/auth.js");

type Mail = { to: string; subject: string; text: string };

function setup(options: { trustExpoGo?: boolean; rateLimit?: boolean } = {}) {
	const mails: Mail[] = [];
	const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [], rateLimit: [] };
	const auth = createAuth({
		database: memoryAdapter(db),
		mail: async (message) => {
			mails.push(message);
		},
		trustExpoGo: options.trustExpoGo ?? false,
		rateLimit: options.rateLimit ? { enabled: true, window: 60, max: 1000, storage: "memory" } : undefined,
	});
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "atlas://", "x-forwarded-for": "203.0.113.7", ...headers },
				body: JSON.stringify(body),
			}),
		);
	const sendCode = (email: string, headers?: Record<string, string>) =>
		post("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers);
	const signIn = (email: string, otp: string, headers?: Record<string, string>) => post("/sign-in/email-otp", { email, otp }, headers);
	const lastCode = () => {
		const mail = mails.at(-1);
		const match = mail?.text.match(/\b(\d{6})\b/);
		assert.ok(match, "nenhum código enviado");
		return match[1] as string;
	};
	return { auth, mails, db, post, sendCode, signIn, lastCode };
}

test("buildTrustedOrigins: atlas:// sempre; exp:// só com a env ligada", () => {
	assert.deepEqual(buildTrustedOrigins("https://a.test", false), ["https://a.test", "atlas://"]);
	assert.deepEqual(buildTrustedOrigins("https://a.test", true), ["https://a.test", "atlas://", "exp://"]);
});

test("o dono recebe o código e entra; a resposta traz o cookie da sessão", async () => {
	const t = setup();
	const sent = await t.sendCode(OWNER);
	assert.equal(sent.status, 200);
	assert.deepEqual(await sent.json(), { success: true });
	assert.equal(t.mails.length, 1);
	assert.equal(t.mails[0]?.to, OWNER);
	const response = await t.signIn(OWNER, t.lastCode());
	assert.equal(response.status, 200);
	assert.ok(response.headers.getSetCookie().some((c) => c.includes("better-auth.session_token=")));
});

test("e-mail que não é do dono: resposta neutra, nenhum e-mail e nenhum código gravado", async () => {
	const t = setup();
	const owner = await t.sendCode(OWNER);
	const other = await t.sendCode("intruso@example.test");
	assert.equal(other.status, owner.status);
	assert.deepEqual(await other.json(), await owner.json());
	assert.equal(t.mails.length, 1);
	assert.equal(t.mails[0]?.to, OWNER);
	assert.equal(t.db.verification?.length, 1);
	const attempt = await t.signIn("intruso@example.test", "123456");
	assert.ok(attempt.status >= 400);
	assert.equal(t.db.user?.length, 0);
});

test("o código do dono não vale para outro e-mail", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const code = t.lastCode();
	const attempt = await t.signIn("intruso@example.test", code);
	assert.ok(attempt.status >= 400);
	assert.equal(t.db.user?.length, 0);
});

test("código errado falha e não cria sessão", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const wrong = t.lastCode() === "000000" ? "111111" : "000000";
	const response = await t.signIn(OWNER, wrong);
	assert.ok(response.status >= 400);
	assert.equal(response.headers.getSetCookie().length, 0);
	assert.equal(t.db.session?.length ?? 0, 0);
});

test("limite de tentativas: depois de errar o máximo, nem o código certo entra", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const right = t.lastCode();
	const wrong = right === "000000" ? "111111" : "000000";
	for (let i = 0; i < EMAIL_OTP_ALLOWED_ATTEMPTS; i++) assert.ok((await t.signIn(OWNER, wrong)).status >= 400);
	const response = await t.signIn(OWNER, right);
	assert.ok(response.status >= 400);
	assert.equal(t.db.session?.length ?? 0, 0);
});

test("código expirado falha", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const code = t.lastCode();
	for (const row of t.db.verification as { expiresAt: Date }[]) row.expiresAt = new Date(Date.now() - 1000);
	const response = await t.signIn(OWNER, code);
	assert.ok(response.status >= 400);
	assert.equal(t.db.session?.length ?? 0, 0);
});

test("código é de uso único", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const code = t.lastCode();
	assert.equal((await t.signIn(OWNER, code)).status, 200);
	assert.ok((await t.signIn(OWNER, code)).status >= 400);
});

test("o código não fica em texto puro no banco", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const stored = (t.db.verification as { value: string }[])[0]?.value ?? "";
	assert.ok(!stored.startsWith(t.lastCode()), stored);
});

test("rate limit do envio de código (por IP)", async () => {
	const t = setup({ rateLimit: true });
	const statuses: number[] = [];
	for (let i = 0; i < 5; i++) statuses.push((await t.sendCode(OWNER)).status);
	assert.equal(statuses[0], 200);
	assert.ok(statuses.includes(429), statuses.join(","));
});

test("origem exp:// não é confiável sem ATLAS_TRUST_EXPO_GO", async () => {
	const t = setup({ trustExpoGo: false });
	const response = await t.sendCode(OWNER, { origin: "exp://192.168.0.5:8081" });
	assert.equal(response.status, 403);
	assert.equal(t.mails.length, 0);
});

test("origem exp:// é confiável com ATLAS_TRUST_EXPO_GO", async () => {
	const t = setup({ trustExpoGo: true });
	const response = await t.sendCode(OWNER, { origin: "exp://192.168.0.5:8081" });
	assert.equal(response.status, 200);
	assert.equal(t.mails.length, 1);
});

test("origem de outro site continua barrada; atlas:// passa; expo-origin vira Origin", async () => {
	const t = setup();
	assert.equal((await t.sendCode(OWNER, { origin: "https://evil.test" })).status, 403);
	const viaExpoHeader = await t.post("/email-otp/send-verification-otp", { email: OWNER, type: "sign-in" }, { origin: "", "expo-origin": "atlas://" });
	// sem Origin, o plugin expo usa o expo-origin
	assert.equal(viaExpoHeader.status, 200);
});

test("callbackURL do login social: exp:// só com a env, atlas:// sempre", async () => {
	const social = (t: ReturnType<typeof setup>, callbackURL: string) =>
		t.post("/sign-in/social", { provider: "google", callbackURL });
	const off = setup({ trustExpoGo: false });
	assert.equal((await social(off, "exp://192.168.0.5:8081/--/")).status, 403);
	// atlas:// passa da checagem de origem (sem credenciais do Google o erro é outro, nunca 403 de origem)
	const ok = await social(off, "atlas://");
	assert.notEqual(ok.status, 403);
	const on = setup({ trustExpoGo: true });
	assert.notEqual((await social(on, "exp://192.168.0.5:8081/--/")).status, 403);
});

test("magic link do web segue funcionando e só para o dono", async () => {
	const t = setup();
	const web = { origin: "http://localhost:3000" };
	const ok = await t.post("/sign-in/magic-link", { email: OWNER }, web);
	assert.equal(ok.status, 200);
	assert.equal(t.mails.length, 1);
	assert.match(t.mails[0]?.text ?? "", /magic-link\/verify/);
	const other = await t.post("/sign-in/magic-link", { email: "intruso@example.test" }, web);
	assert.ok(other.status >= 400);
	assert.equal(t.mails.length, 1);
});

test("requireUser aceita o cookie da sessão (formato que o app manda) e escopa pelo user.id", async () => {
	const t = setup();
	await t.sendCode(OWNER);
	const login = await t.signIn(OWNER, t.lastCode());
	const cookie = login.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	const app = new Hono<import("./middleware/auth.js").AuthEnv>();
	app.use("/v1/*", createRequireUser(t.auth));
	app.get("/v1/me", (c) => c.json({ ...scopeFor(c.get("session")), email: c.get("user").email }));
	const anon = await app.request("/v1/me");
	assert.equal(anon.status, 401);
	const logged = await app.request("/v1/me", { headers: { cookie } });
	assert.equal(logged.status, 200);
	const body = (await logged.json()) as { userId: string; email: string };
	assert.equal(body.email, OWNER);
	assert.ok(body.userId);
	// sair derruba a sessão
	const out = await t.post("/sign-out", {}, { cookie });
	assert.equal(out.status, 200);
	assert.equal((await app.request("/v1/me", { headers: { cookie } })).status, 401);
});
