/**
 * Ponte de login do app mobile (rotas/mobile-auth.ts). Banco em memória e e-mail capturado: sem rede, sem Postgres.
 * O Google real não entra: o teste faz o papel do navegador depois dele (sessão do dono por código de e-mail).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";

const OWNER = "owner@example.test";
process.env.ATLAS_OWNER_EMAIL = OWNER;
process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret";
process.env.ATLAS_URL = "http://localhost:3000";
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-secret";

const { createAuth, isOwnerEmail } = await import("../auth.js");
const { createMobileAuthRoutes } = await import("./mobile-auth.js");
const { parseMobileReturn, parseMobileState, appendReturnParams, challengeOf, createKeyLimiter } = await import("../mobile-auth.js");

const ORIGIN = "http://localhost:3000";
const STATE = "nonce_nonce_nonce_1234";
const VERIFIER = "verifier_verifier_verifier_verifier_1234567890";
const CHALLENGE = challengeOf(VERIFIER);
const ATLAS_RETURN = "atlas:///";
const EXPO_RETURN = "exp://u.expo.dev/0633915b-effc-4a73-9265-44a7813e2ce1/group/g1/--/";

type Row = Record<string, unknown>;

function setup(options: { maxStartsPerState?: number; trustExpoGo?: boolean; owner?: (email: string) => boolean; now?: () => number } = {}) {
	const mails: { text: string }[] = [];
	const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [], rateLimit: [] };
	const trustExpoGo = options.trustExpoGo ?? false;
	const auth = createAuth({ database: memoryAdapter(db), mail: async (m) => void mails.push(m), trustExpoGo });
	const app = createMobileAuthRoutes({
		auth,
		baseOrigin: ORIGIN,
		trustExpoGo,
		isOwnerEmail: options.owner ?? isOwnerEmail,
		secret: process.env.BETTER_AUTH_SECRET as string,
		now: options.now,
		maxStartsPerState: options.maxStartsPerState,
	});
	const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
		const { cookie, ...rest } = init;
		return app.request(`${ORIGIN}${path}`, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
	};
	/** Sessão do dono como se o Google tivesse acabado de entrar: devolve o cabeçalho Cookie do navegador. */
	const ownerSessionCookie = async () => {
		const post = (path: string, body: unknown) =>
			auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }));
		await post("/email-otp/send-verification-otp", { email: OWNER, type: "sign-in" });
		const otp = mails.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
		assert.ok(otp, "nenhum código enviado");
		const res = await post("/sign-in/email-otp", { email: OWNER, otp });
		assert.equal(res.status, 200);
		return jar(res.headers.getSetCookie());
	};
	const start = (ret = ATLAS_RETURN, state = STATE, challenge = CHALLENGE) => call(`/api/mobile/auth/start?return=${encodeURIComponent(ret)}&state=${state}&code_challenge=${challenge}`);
	return { auth, db, call, start, ownerSessionCookie };
}

/** "nome=valor; nome2=valor2" a partir de Set-Cookie (descarta cookies apagados). */
function jar(setCookies: string[]): string {
	return setCookies
		.map((c) => c.split(";")[0] as string)
		.filter((c) => !/^[^=]+=$/.test(c))
		.join("; ");
}

function linkFrom(html: string): URL {
	const href = html.match(/<a id="back" href="([^"]+)"/)?.[1];
	assert.ok(href, "página sem o botão Voltar para o app");
	return new URL(href.replaceAll("&amp;", "&"));
}

test("parseMobileReturn: atlas:// sempre; exp:// só com a env; o resto é recusado", () => {
	const off = { trustExpoGo: false };
	const on = { trustExpoGo: true };
	assert.equal(parseMobileReturn(ATLAS_RETURN, off), ATLAS_RETURN);
	assert.equal(parseMobileReturn("atlas://", off), "atlas://");
	assert.equal(parseMobileReturn(EXPO_RETURN, off), null);
	assert.equal(parseMobileReturn(EXPO_RETURN, on), EXPO_RETURN);
	assert.equal(parseMobileReturn("exp://192.168.0.5:8081/--/", on), "exp://192.168.0.5:8081/--/");
	for (const bad of [
		"https://evil.example/",
		"http://evil.example/",
		"//evil.example",
		"javascript:alert(1)",
		"intent://scan/#Intent;scheme=zxing;end",
		"data:text/html,x",
		"evil://x",
		"exp+atlas://x",
		"atlas://x#frag",
		"atlas://user:pass@x/",
		'atlas://x"onload=alert(1)',
		"atlas://x\\evil",
		"atlas://x y",
		"exp:///--/",
		"",
		`atlas://${"a".repeat(3000)}`,
	]) {
		assert.equal(parseMobileReturn(bad, on), null, bad);
	}
	assert.equal(parseMobileReturn(undefined, on), null);
	assert.equal(parseMobileReturn(["atlas://"], on), null);
});

test("parseMobileState e appendReturnParams", () => {
	assert.equal(parseMobileState(STATE), STATE);
	for (const bad of ["curto", "tem espaço tem espaço", "a".repeat(129), "<script>aaaaaaaaaaaaaaa", undefined, 12]) assert.equal(parseMobileState(bad), null);
	assert.equal(appendReturnParams("atlas:///", { token: "t", state: "s" }), "atlas:///?token=t&state=s");
	assert.equal(appendReturnParams("exp://h/--/?a=1", { token: "t" }), "exp://h/--/?a=1&token=t");
});

test("start: return fora da lista (https://evil) é recusado, sem ir ao Google nem gravar cookie", async () => {
	const t = setup({ trustExpoGo: true });
	for (const ret of ["https://evil.example/steal", "javascript:alert(1)", "http://localhost:3000/"]) {
		const res = await t.start(ret);
		assert.equal(res.status, 400, ret);
		assert.equal(res.headers.get("location"), null);
		assert.deepEqual(res.headers.getSetCookie(), []);
	}
	assert.equal((await t.start(EXPO_RETURN, "curto")).status, 400);
	assert.equal((await setup({ trustExpoGo: false }).start(EXPO_RETURN)).status, 400, "exp:// sem a env");
});

test("start: retorno válido vai ao Google com callback na página do servidor e guarda return/state em cookie assinado", async () => {
	const t = setup();
	const res = await t.start();
	assert.equal(res.status, 302);
	const location = new URL(res.headers.get("location") as string);
	assert.equal(location.origin, "https://accounts.google.com");
	assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/google`);
	assert.notEqual(location.searchParams.get("state"), STATE, "o state do Google não é o do app");
	const cookies = res.headers.getSetCookie();
	const bridge = cookies.find((c) => c.startsWith("atlas_mobile_auth="));
	assert.ok(bridge, "cookie da ponte");
	assert.match(bridge, /HttpOnly/i);
	assert.match(bridge, /SameSite=Lax/i);
	assert.match(bridge, /Max-Age=600/i);
	assert.match(bridge, /Path=\/api\/mobile\/auth/i);
	assert.ok(cookies.some((c) => /better-auth\.state=/.test(c)), "cookie de estado do OAuth do better-auth");
	assert.equal(res.headers.get("cache-control"), "no-store");
});

test("fluxo completo: Google → página de retorno com o token → troca por sessão", async () => {
	const t = setup();
	const bridgeCookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const session = await t.ownerSessionCookie();

	const done = await t.call("/api/mobile/auth/done", { cookie: `${bridgeCookie}; ${session}` });
	assert.equal(done.status, 200);
	assert.equal(done.headers.get("cache-control"), "no-store");
	const csp = done.headers.get("content-security-policy") as string;
	assert.match(csp, /script-src 'nonce-[\w-]+'/);
	assert.match(csp, /frame-ancestors 'none'/);
	const html = await done.text();
	assert.match(html, /Pronto! Voltando para o app…/);
	assert.match(html, /Voltar para o app/);
	assert.ok(html.includes("location.replace("), "tenta voltar sozinho por JS");
	const link = linkFrom(html);
	assert.equal(link.protocol, "atlas:");
	assert.equal(link.searchParams.get("state"), STATE);
	const token = link.searchParams.get("token") as string;
	assert.ok(token && token.length >= 16);
	// a página consumiu o cookie da ponte: recarregar não gera outro token
	assert.match(done.headers.getSetCookie().join("\n"), /atlas_mobile_auth=;/);

	// o token não fica em claro no banco
	const stored = t.db.verification?.filter((v) => String(v.identifier).startsWith("one-time-token:")) ?? [];
	assert.equal(stored.length, 1);
	assert.ok(!JSON.stringify(stored).includes(token));
	const ttl = (stored[0]?.expiresAt as Date).getTime() - Date.now();
	assert.ok(ttl > 55_000 && ttl <= 61_000, `vale 60 s (deu ${ttl} ms)`);

	const exchange = await t.call("/api/mobile/auth/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, code_verifier: VERIFIER }) });
	assert.equal(exchange.status, 200);
	assert.deepEqual(await exchange.json(), { ok: true });
	const newCookie = jar(exchange.headers.getSetCookie());
	assert.match(newCookie, /better-auth\.session_token=/);
	const me = await t.auth.api.getSession({ headers: new Headers({ cookie: newCookie }) });
	assert.equal(me?.user.email, OWNER);
});

test("exchange: reutilizar o token falha", async () => {
	const t = setup();
	const bridgeCookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const html = await (await t.call("/api/mobile/auth/done", { cookie: `${bridgeCookie}; ${await t.ownerSessionCookie()}` })).text();
	const token = linkFrom(html).searchParams.get("token") as string;
	const exchange = () => t.call("/api/mobile/auth/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, code_verifier: VERIFIER }) });
	assert.equal((await exchange()).status, 200);
	const second = await exchange();
	assert.equal(second.status, 401);
	assert.deepEqual(second.headers.getSetCookie(), []);
});

test("exchange: token vencido, inventado ou malformado não vira sessão", async () => {
	const t = setup();
	const bridgeCookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const html = await (await t.call("/api/mobile/auth/done", { cookie: `${bridgeCookie}; ${await t.ownerSessionCookie()}` })).text();
	const token = linkFrom(html).searchParams.get("token") as string;
	for (const row of t.db.verification ?? []) if (String(row.identifier).startsWith("one-time-token:")) row.expiresAt = new Date(Date.now() - 1000);
	const post = (body: unknown) => t.call("/api/mobile/auth/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const expired = await post({ token, code_verifier: VERIFIER });
	assert.equal(expired.status, 401);
	assert.deepEqual(expired.headers.getSetCookie(), []);
	assert.equal((await post({ token: "x".repeat(43), code_verifier: VERIFIER })).status, 401);
	assert.equal((await post({ token: "curto" })).status, 400);
	assert.equal((await post({})).status, 400);
	assert.equal((await post({ token: { $ne: 1 } })).status, 400);
});

test("outro usuário: sessão que não é do dono não gera nem troca token", async () => {
	// A sessão existe (é a do dono no banco), mas o servidor a trata como "outra conta": a regra é o isOwnerEmail.
	const stranger = setup({ owner: () => false });
	const bridgeCookie = jar((await stranger.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const done = await stranger.call("/api/mobile/auth/done", { cookie: `${bridgeCookie}; ${await stranger.ownerSessionCookie()}` });
	const html = await done.text();
	assert.match(html, /Não foi possível entrar/);
	const link = linkFrom(html);
	assert.equal(link.searchParams.get("error"), "access_denied");
	assert.equal(link.searchParams.get("token"), null);
	assert.equal(stranger.db.verification?.filter((v) => String(v.identifier).startsWith("one-time-token:")).length, 0);

	// Token válido de uma sessão que deixou de ser do dono: a troca recusa e não entrega o cookie.
	const t = setup();
	const cookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const token = linkFrom(await (await t.call("/api/mobile/auth/done", { cookie: `${cookie}; ${await t.ownerSessionCookie()}` })).text()).searchParams.get("token") as string;
	const notOwner = createMobileAuthRoutes({ auth: t.auth, baseOrigin: ORIGIN, trustExpoGo: false, isOwnerEmail: () => false, secret: process.env.BETTER_AUTH_SECRET as string });
	const res = await notOwner.request(`${ORIGIN}/api/mobile/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, code_verifier: VERIFIER }) });
	assert.equal(res.status, 401);
	assert.deepEqual(res.headers.getSetCookie(), []);
});

test("done: sem sessão, sem cookie da ponte, cookie adulterado ou vencido não gera token", async () => {
	const t = setup();
	const bridgeCookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	// sem sessão: volta ao app com erro
	const noSession = await (await t.call("/api/mobile/auth/done", { cookie: bridgeCookie })).text();
	assert.equal(linkFrom(noSession).searchParams.get("error"), "access_denied");
	assert.equal(linkFrom(noSession).searchParams.get("token"), null);
	// cancelou/negou no Google (errorCallbackURL)
	const denied = await (await t.call("/api/mobile/auth/done?failed=1&error=access_denied", { cookie: `${bridgeCookie}; ${await t.ownerSessionCookie()}` })).text();
	assert.equal(linkFrom(denied).searchParams.get("token"), null);
	// sem cookie da ponte (aberta direto): não há para onde voltar, nem token
	const direct = await (await t.call("/api/mobile/auth/done", { cookie: await t.ownerSessionCookie() })).text();
	assert.ok(!direct.includes("<a "), "sem botão");
	assert.match(direct, /expirou/);
	// cookie adulterado: assinatura não confere
	const tampered = bridgeCookie.replace(/=.{6}/, "=AAAAAA");
	const forged = await (await t.call("/api/mobile/auth/done", { cookie: `${tampered}; ${await t.ownerSessionCookie()}` })).text();
	assert.ok(!forged.includes("<a "));
	assert.equal(t.db.verification?.filter((v) => String(v.identifier).startsWith("one-time-token:")).length, 0);
	// vencido (mais de 10 min depois)
	const late = setup({ now: () => Date.now() + 11 * 60_000 });
	const lateCookie = jar((await late.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const expired = createMobileAuthRoutes({ auth: late.auth, baseOrigin: ORIGIN, trustExpoGo: false, isOwnerEmail, secret: process.env.BETTER_AUTH_SECRET as string, now: () => Date.now() + 30 * 60_000 });
	const res = await expired.request(`${ORIGIN}/api/mobile/auth/done`, { headers: { cookie: `${lateCookie}; ${await late.ownerSessionCookie()}` } });
	assert.ok(!(await res.text()).includes("<a "));
});

test("o token não pode ser pedido direto pelo cliente em /api/auth (só a página de retorno o gera)", async () => {
	const t = setup();
	const session = await t.ownerSessionCookie();
	const res = await t.auth.handler(new Request(`${ORIGIN}/api/auth/one-time-token/generate`, { headers: { cookie: session, origin: ORIGIN } }));
	assert.equal(res.status, 400);
	assert.equal(t.db.verification?.filter((v) => String(v.identifier).startsWith("one-time-token:")).length, 0);
});

test("a página escapa o link: state e retorno não abrem HTML nem JS", async () => {
	const t = setup();
	const bridgeCookie = jar((await t.start("atlas://x?a=1&b=2")).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const html = await (await t.call("/api/mobile/auth/done", { cookie: `${bridgeCookie}; ${await t.ownerSessionCookie()}` })).text();
	assert.ok(html.includes("atlas://x?a=1&amp;b=2&amp;token="), "href escapado");
	assert.ok(!/<script(?![^>]*nonce=)/.test(html), "todo script leva nonce");
});

async function mintToken(t: ReturnType<typeof setup>) {
	const cookie = jar((await t.start()).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const html = await (await t.call("/api/mobile/auth/done", { cookie: `${cookie}; ${await t.ownerSessionCookie()}` })).text();
	const link = linkFrom(html);
	return { token: link.searchParams.get("token") as string, state: link.searchParams.get("state") };
}
const exchangeWith = (t: ReturnType<typeof setup>, body: unknown) =>
	t.call("/api/mobile/auth/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PKCE: token e state interceptados, mas verifier errado ou ausente → 401, e o app legítimo ainda troca", async () => {
	const t = setup();
	const { token } = await mintToken(t);
	for (const body of [{ token }, { token, code_verifier: "outro_verifier_outro_verifier_outro_verifier_1" }, { token, code_verifier: "curto" }, { token, code_verifier: 5 }]) {
		const res = await exchangeWith(t, body);
		assert.equal(res.status, 401, JSON.stringify(body));
		assert.deepEqual(res.headers.getSetCookie(), []);
	}
	const ok = await exchangeWith(t, { token, code_verifier: VERIFIER });
	assert.equal(ok.status, 200);
	assert.match(jar(ok.headers.getSetCookie()), /better-auth\.session_token=/);
});

test("PKCE: o verifier de uma tentativa não troca o token de outra", async () => {
	const t = setup();
	const other = "segundo_verifier_segundo_verifier_segundo_1";
	const cookie = jar((await t.start(ATLAS_RETURN, STATE, challengeOf(other))).headers.getSetCookie().filter((c) => c.startsWith("atlas_mobile_auth=")));
	const html = await (await t.call("/api/mobile/auth/done", { cookie: `${cookie}; ${await t.ownerSessionCookie()}` })).text();
	const token = linkFrom(html).searchParams.get("token") as string;
	assert.equal((await exchangeWith(t, { token, code_verifier: VERIFIER })).status, 401);
	assert.equal((await exchangeWith(t, { token, code_verifier: other })).status, 200);
});

test("start sem code_challenge válido é recusado", async () => {
	const t = setup();
	for (const challenge of ["", "curto", "!".repeat(43)]) assert.equal((await t.start(ATLAS_RETURN, STATE, challenge)).status, 400);
});

test("duas trocas simultâneas do mesmo token: só uma vence", async () => {
	const t = setup();
	const { token } = await mintToken(t);
	const results = await Promise.all(Array.from({ length: 4 }, () => exchangeWith(t, { token, code_verifier: VERIFIER })));
	assert.equal(results.filter((r) => r.status === 200).length, 1);
	assert.equal(results.filter((r) => r.status === 401).length, 3);
});

test("EXP:// com caixa variada: recusado sem a env, aceito com ela", () => {
	for (const raw of ["EXP://u.expo.dev/x/--/", "Exp://192.168.0.5:8081/--/"]) {
		assert.equal(parseMobileReturn(raw, { trustExpoGo: false }), null, raw);
		assert.equal(parseMobileReturn(raw, { trustExpoGo: true }), raw, raw);
	}
	assert.equal(parseMobileReturn("ATLAS://x", { trustExpoGo: false }), "ATLAS://x");
	assert.equal(parseMobileReturn("HTTPS://evil.example", { trustExpoGo: true }), null);
});

test("limite por state no /start: o excesso responde 429 e outro state segue livre", async () => {
	const t = setup({ maxStartsPerState: 2 });
	assert.equal((await t.start()).status, 302);
	assert.equal((await t.start()).status, 302);
	assert.equal((await t.start()).status, 429);
	assert.equal((await t.start(ATLAS_RETURN, "outro_nonce_outro_nonce_1")).status, 302);
	let clock = 0;
	const limiter = createKeyLimiter(1, 1000, () => clock);
	assert.equal(limiter.allow("a"), true);
	assert.equal(limiter.allow("a"), false);
	clock = 1001;
	assert.equal(limiter.allow("a"), true);
});

test("start: URL inválida vinda do provedor mostra a página de erro, não 500", async () => {
	const fake = {
		api: { signInSocial: async () => new Response(JSON.stringify({ url: "isto não é url" }), { headers: { "content-type": "application/json" } }) },
		$context: Promise.resolve({}),
	} as unknown as Parameters<typeof createMobileAuthRoutes>[0]["auth"];
	const app = createMobileAuthRoutes({ auth: fake, baseOrigin: ORIGIN, trustExpoGo: false, isOwnerEmail, secret: process.env.BETTER_AUTH_SECRET as string });
	const res = await app.request(`${ORIGIN}/api/mobile/auth/start?return=${encodeURIComponent(ATLAS_RETURN)}&state=${STATE}&code_challenge=${CHALLENGE}`);
	assert.equal(res.status, 400);
	const html = await res.text();
	assert.equal(new URL(linkFrom(html)).searchParams.get("error"), "unavailable");
});
