/**
 * Passagem de sessão do app mobile para o navegador do sistema (conectar conector OAuth).
 *
 * O app guarda a sessão dentro dele; o callback do OAuth (`/v1/mcp/oauth/callback`, `/v1/composio/callback`) exige a
 * sessão do dono por cookie e o navegador do celular não a tem. Desenho: a rota autenticada (POST de conexão com
 * `client: "mobile"`) gera um token aleatório de 256 bits, de uso único, que vale 60 s e fica só como HASH no banco
 * (tabela `verification` do better-auth; a busca é pelo hash, então não há comparação de segredo em memória). Ao abrir
 * `GET /v1/mobile/oauth-handoff?t=`, o servidor consome o token e cria uma sessão NOVA e curta (10 min) do mesmo
 * usuário, grava o cookie e vai (302) para a URL de autorização que o próprio servidor gerou. Não reaproveita a sessão
 * do app: o navegador nunca recebe a credencial de longa duração.
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { setSignedCookie } from "hono/cookie";
import type { createAuth } from "./auth.js";

export const MOBILE_OAUTH_HANDOFF_PATH = "/v1/mobile/oauth-handoff";
export const OAUTH_HANDOFF_TTL_MS = 60_000;
/** Vida da sessão do navegador: cobre a tela de consentimento do provedor e nada além. */
export const OAUTH_HANDOFF_SESSION_TTL_MS = 10 * 60_000;
/** Marca das sessões criadas aqui; o callback do OAuth as revoga ao terminar. */
export const OAUTH_HANDOFF_USER_AGENT = "atlas-oauth-handoff";
const IDENTIFIER_PREFIX = "atlas-oauth-handoff:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export type ParseClientResult = { ok: true; mobile: boolean } | { ok: false; error: string };

/** `client` opcional no corpo dos POSTs de conexão: só o literal "mobile". */
export function parseOAuthClient(body: unknown): ParseClientResult {
	const client = typeof body === "object" && body !== null ? (body as { client?: unknown }).client : undefined;
	if (client === undefined) return { ok: true, mobile: false };
	if (client === "mobile") return { ok: true, mobile: true };
	return { ok: false, error: 'client inválido: use "mobile" ou omita o campo' };
}

type AuthLike = Pick<ReturnType<typeof createAuth>, "$context">;

export type OAuthHandoff = {
	/** Devolve a URL absoluta do handoff para `next` (URL de autorização gerada pelo servidor). */
	mint(input: { userId: string; sessionId: string; next: string }): Promise<string>;
};

export type HandoffDeps = { auth: AuthLike; baseOrigin: string; now?: () => number };

export function createOAuthHandoff(deps: HandoffDeps): OAuthHandoff {
	const now = deps.now ?? Date.now;
	return {
		async mint({ userId, sessionId, next }) {
			const url = new URL(next);
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("next inválido");
			const token = randomBytes(32).toString("base64url");
			const ctx = await deps.auth.$context;
			await ctx.internalAdapter.createVerificationValue({
				identifier: `${IDENTIFIER_PREFIX}${sha256Hex(token)}`,
				value: JSON.stringify({ u: userId, s: sessionId, n: next }),
				expiresAt: new Date(now() + OAUTH_HANDOFF_TTL_MS),
			});
			return `${deps.baseOrigin}${MOBILE_OAUTH_HANDOFF_PATH}?t=${token}`;
		},
	};
}

/**
 * Anexa `handoffUrl` à resposta quando o app pediu (`client: "mobile"`) e há URL de autorização.
 * Falha ao gerar o token não derruba a conexão: o app cai no `authorizeUrl` de sempre.
 */
export async function withHandoffUrl<T extends Record<string, unknown>>(
	payload: T,
	input: { mobile: boolean; handoff: OAuthHandoff; userId: string; sessionId: string; next: string | null | undefined },
): Promise<T & { handoffUrl?: string }> {
	if (!input.mobile || !input.next) return payload;
	try {
		return { ...payload, handoffUrl: await input.handoff.mint({ userId: input.userId, sessionId: input.sessionId, next: input.next }) };
	} catch {
		return payload;
	}
}

const EXPIRED_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Link expirado</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif}main{max-width:22rem;padding:1.5rem;text-align:center}</style>
</head><body><main><h1>Link expirado</h1><p>Link expirado. Volte ao app e tente de novo.</p></main></body></html>`;
const PAGE_HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

/** Cabeçalhos da rota em TODA resposta (inclusive 429 do limite por IP): vai antes do limitador. */
export const handoffResponseHeaders = createMiddleware(async (c, next) => {
	for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
	await next();
});

export type HandoffRoutesDeps = HandoffDeps;

/** Rota pública (allowlist em middleware/auth.ts): quem autentica é o token da URL. Nunca loga o token. */
export function createMobileOAuthHandoffRoutes(deps: HandoffRoutesDeps) {
	const app = new Hono();
	const now = deps.now ?? Date.now;
	app.get(MOBILE_OAUTH_HANDOFF_PATH, async (c) => {
		for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
		const expired = () => c.html(EXPIRED_HTML, 410);
		const token = c.req.query("t");
		if (!token || !TOKEN_PATTERN.test(token)) return expired();
		const ctx = await deps.auth.$context;
		// Consumo atômico por hash: duas aberturas simultâneas não passam as duas.
		const claimed = await ctx.internalAdapter.consumeVerificationValue(`${IDENTIFIER_PREFIX}${sha256Hex(token)}`).catch(() => null);
		if (!claimed || claimed.expiresAt.getTime() <= now()) return expired();
		let payload: { u?: unknown; s?: unknown; n?: unknown };
		try { payload = JSON.parse(claimed.value); } catch { return expired(); }
		if (typeof payload.u !== "string" || typeof payload.s !== "string" || typeof payload.n !== "string") return expired();
		// Amarrado à sessão que pediu: se o app já saiu (sessão revogada ou vencida), o link morre junto.
		const origin = await ctx.adapter
			.findOne<{ userId: string; expiresAt: Date }>({ model: "session", where: [{ field: "id", value: payload.s }] })
			.catch(() => null);
		if (!origin || origin.userId !== payload.u || new Date(origin.expiresAt).getTime() <= now()) return expired();
		const session = await ctx.internalAdapter
			.createSession(payload.u, false, { expiresAt: new Date(now() + OAUTH_HANDOFF_SESSION_TTL_MS), userAgent: OAUTH_HANDOFF_USER_AGENT }, true)
			.catch(() => null);
		if (!session) return expired();
		const cookie = ctx.authCookies.sessionToken;
		await setSignedCookie(c, cookie.name, session.token, ctx.secret, {
			path: "/",
			httpOnly: true,
			secure: cookie.attributes.secure === true,
			sameSite: "Lax",
			maxAge: OAUTH_HANDOFF_SESSION_TTL_MS / 1000,
		});
		return c.redirect(payload.n, 302);
	});
	return app;
}

/**
 * Depois do callback do OAuth a sessão curta não serve mais: revoga a sessão marcada. O better-auth renova sessão perto
 * do fim (`updateAge`), então não dá para confiar só no TTL.
 */
export function createHandoffSessionRevoker(auth: AuthLike & { api: { getSession(input: { headers: Headers }): Promise<{ session: { token: string; userAgent?: string | null } } | null> } }) {
	return createMiddleware(async (c, next) => {
		const current = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
		try {
			await next();
		} finally {
			if (current?.session.userAgent === OAUTH_HANDOFF_USER_AGENT) {
				const ctx = await auth.$context;
				await ctx.internalAdapter.deleteSession(current.session.token).catch(() => undefined);
			}
		}
	});
}
