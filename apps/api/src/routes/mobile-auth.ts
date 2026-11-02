/**
 * Login do app mobile pelo navegador, no desenho de ponte (como o Grok): o app abre `/start`, o servidor inicia o
 * Google normal do better-auth e volta para uma página HTTPS nossa (`/done`), que entrega o token ao app por um
 * link/botão. Não depende de 302 automático para esquema próprio nem do proxy do plugin do Expo.
 *
 *   GET  /api/mobile/auth/start?return=<deeplink>&state=<nonce>  → 302 para o Google (+ cookie assinado com return e state)
 *   GET  /api/mobile/auth/done                                    → HTML "Voltar para o app" com token de uso único
 *   POST /api/mobile/auth/exchange {token}                        → troca o token pela sessão (Set-Cookie)
 */
import { createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { createAuth } from "../auth.js";
import {
	appendReturnParams,
	decodeBridgeCookie,
	donePageCsp,
	encodeBridgeCookie,
	parseMobileReturn,
	parseMobileState,
	renderDonePage,
} from "../mobile-auth.js";

export const MOBILE_AUTH_PATH = "/api/mobile/auth";
const BRIDGE_COOKIE = "atlas_mobile_auth";
/** O Google pode pedir consentimento: 10 min cobrem o login mais lento sem deixar o cookie vivo à toa. */
const BRIDGE_COOKIE_TTL_SECONDS = 600;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type MobileAuthDeps = {
	auth: Pick<ReturnType<typeof createAuth>, "api">;
	/** Origem pública do servidor (`ATLAS_URL`), sem caminho. */
	baseOrigin: string;
	trustExpoGo: boolean;
	isOwnerEmail: (email: string) => boolean;
	/** Segredo do servidor (`BETTER_AUTH_SECRET`); a chave do cookie é derivada dele. */
	secret: string;
	now?: () => number;
};

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;

export function createMobileAuthRoutes(deps: MobileAuthDeps) {
	const app = new Hono();
	const now = deps.now ?? Date.now;
	const secure = new URL(deps.baseOrigin).protocol === "https:";
	// Chave própria do cookie: não reaproveita o segredo cru do better-auth para assinar outra coisa.
	const cookieKey = createHmac("sha256", deps.secret).update("atlas-mobile-auth-cookie-v1").digest("hex");
	const options = { trustExpoGo: deps.trustExpoGo };

	const page = (c: Context, input: { link: string | null; ok: boolean }, status: 200 | 400 = 200) => {
		const nonce = randomBytes(16).toString("base64url");
		c.header("Content-Security-Policy", donePageCsp(nonce));
		for (const [name, value] of Object.entries(NO_STORE)) c.header(name, value);
		c.header("X-Frame-Options", "DENY");
		return c.html(renderDonePage({ ...input, nonce }), status);
	};

	app.get(`${MOBILE_AUTH_PATH}/start`, async (c) => {
		const returnUrl = parseMobileReturn(c.req.query("return"), options);
		const state = parseMobileState(c.req.query("state"));
		if (!returnUrl || !state) return page(c, { link: null, ok: false }, 400);

		const google = await deps.auth.api
			.signInSocial({
				body: {
					provider: "google",
					callbackURL: `${deps.baseOrigin}${MOBILE_AUTH_PATH}/done`,
					errorCallbackURL: `${deps.baseOrigin}${MOBILE_AUTH_PATH}/done?failed=1`,
					disableRedirect: true,
				},
				asResponse: true,
			})
			.catch(() => null);
		if (!google?.ok) return page(c, { link: appendReturnParams(returnUrl, { error: "unavailable", state }), ok: false }, 400);
		const { url } = (await google.json().catch(() => ({}))) as { url?: string };
		if (!url || new URL(url).protocol !== "https:") return page(c, { link: appendReturnParams(returnUrl, { error: "unavailable", state }), ok: false }, 400);

		// Cookies do estado do OAuth (state assinado) que o better-auth precisa no retorno do Google.
		for (const cookie of google.headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
		await setSignedCookie(c, BRIDGE_COOKIE, encodeBridgeCookie({ r: returnUrl, s: state, exp: now() + BRIDGE_COOKIE_TTL_SECONDS * 1000 }), cookieKey, {
			path: MOBILE_AUTH_PATH,
			httpOnly: true,
			secure,
			sameSite: "Lax",
			maxAge: BRIDGE_COOKIE_TTL_SECONDS,
		});
		for (const [name, value] of Object.entries(NO_STORE)) c.header(name, value);
		return c.redirect(url, 302);
	});

	app.get(`${MOBILE_AUTH_PATH}/done`, async (c) => {
		const signed = await getSignedCookie(c, cookieKey, BRIDGE_COOKIE);
		const bridge = signed ? decodeBridgeCookie(signed, { ...options, now: now() }) : null;
		if (!bridge) return page(c, { link: null, ok: false });
		const fail = () => page(c, { link: appendReturnParams(bridge.returnUrl, { error: "access_denied", state: bridge.state }), ok: false });

		if (c.req.query("failed") || c.req.query("error")) {
			deleteCookie(c, BRIDGE_COOKIE, { path: MOBILE_AUTH_PATH });
			return fail();
		}
		// Só o dono: sessão ausente ou de outra conta não gera token.
		const session = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
		if (!session || !deps.isOwnerEmail(session.user.email)) {
			deleteCookie(c, BRIDGE_COOKIE, { path: MOBILE_AUTH_PATH });
			return fail();
		}
		const minted = await deps.auth.api.generateOneTimeToken({ headers: c.req.raw.headers }).catch(() => null);
		if (!minted?.token) return fail();
		// Uso único também aqui: recarregar a página não gera outro token sem passar pelo Google de novo.
		deleteCookie(c, BRIDGE_COOKIE, { path: MOBILE_AUTH_PATH });
		return page(c, { link: appendReturnParams(bridge.returnUrl, { token: minted.token, state: bridge.state }), ok: true });
	});

	app.post(`${MOBILE_AUTH_PATH}/exchange`, async (c) => {
		for (const [name, value] of Object.entries(NO_STORE)) c.header(name, value);
		const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
		const token = body?.token;
		if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return c.json({ error: "invalid_token" }, 400);

		const verified = await deps.auth.api.verifyOneTimeToken({ body: { token }, asResponse: true }).catch(() => null);
		if (!verified?.ok) return c.json({ error: "invalid_token" }, 401);
		const result = (await verified.clone().json().catch(() => null)) as { user?: { email?: string } } | null;
		// A resposta do better-auth traz o token da sessão no corpo: não é repassada, só o cookie.
		if (!result?.user?.email || !deps.isOwnerEmail(result.user.email)) return c.json({ error: "invalid_token" }, 401);
		for (const cookie of verified.headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
		return c.json({ ok: true });
	});

	return app;
}
