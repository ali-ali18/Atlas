import { createMiddleware } from "hono/factory";
import { auth, isOwnerEmail, type AuthSession } from "../auth.js";

export type AuthEnv = {
	Variables: {
		session: AuthSession;
		user: AuthSession["user"];
	};
};

export function scopeFor(session: AuthSession) {
	return { userId: session.user.id };
}

export function isPublicV1Request(method: string, path: string): boolean {
	// Webhook do GitHub App: sem sessão; autentica pela assinatura HMAC (X-Hub-Signature-256).
	if (method === "POST" && path === "/v1/github-app/webhook") return true;
	// Painel compartilhado por link público (somente leitura): sem sessão; autoriza pelo token da URL (256 bits, só o
	// hash fica no banco), revogável pelo dono, limitado por IP e com resposta mínima (rotas/public-pages.ts).
	if (method === "GET" && /^\/v1\/public\/paineis\/[A-Za-z0-9_-]{43}$/.test(path)) return true;
	// Entrada de e-mail do bot: sem sessão; autentica pelo token da URL + assinatura HMAC do provedor.
	if ((method === "POST" || method === "GET") && /^\/v1\/email\/inbound\/[^/]+$/.test(path)) return true;
	// Ícone de notificação push (PNG do avatar): público, a chave só tem forma e cor.
	if (method === "GET" && path.startsWith("/v1/avatars/") && !path.slice(12).includes("/")) return true;
	// Aviso de fim de job do container da sessão: autentica por HMAC do token da sessão (rota dev-job-callback).
	if (method === "POST" && path === "/v1/internal/dev-jobs/callback") return true;
	// Prévia no modo básico (`/v1/previews/<id>/p/...`): o documento roda em sandbox (origem opaca) e NÃO envia o cookie de login, então a
	// autenticação é o cookie próprio da prévia (HttpOnly, só deste caminho, assinado por id+dono+validade), conferido em
	// rotas/previews.ts. Só o prefixo exato com id de sessão (a-z0-9, 20-40); `/open` e o resto de /v1/previews seguem com login.
	if (/^\/v1\/previews\/[a-z0-9]{20,40}\/p(?:\/.*)?$/.test(path)) return true;
	if (method === "POST" && /^\/v1\/hooks\/[^/]+(?:\/[^/]+)?$/.test(path)) return true;
	// GET só responde a dica "use POST" (405), igual para qualquer hookKey.
	if (method === "GET" && /^\/v1\/hooks\/[^/]+$/.test(path)) return true;
	return false;
}

/**
 * Link de prévia (`GET /v1/previews/<id>/open`) aberto sem login (outro navegador, celular). Só nesta rota e só para navegação
 * (Accept com text/html): página estática no lugar do JSON cru. O login do web não tem caminho de retorno (`callbackURL` fixo em
 * "/"), então a página só leva ao login e a pessoa volta a tocar no link. Independe do id (qualquer um responde igual), então não
 * revela se a prévia existe.
 */
export function isPreviewOpenNavigation(method: string, path: string, accept: string | undefined): boolean {
	return method === "GET" && /^\/v1\/previews\/[^/]+\/open$/.test(path) && /\btext\/html\b/i.test(accept ?? "");
}

const PREVIEW_LOGIN_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Entre no Atlas</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--muted:#6b6b6b;--btn:#171717;--btn-fg:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f2f2f2;--muted:#9a9a9a;--btn:#f2f2f2;--btn-fg:#141414}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:22rem;padding:1.5rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:var(--muted)}
a{display:inline-block;padding:.65rem 1.25rem;border-radius:.75rem;background:var(--btn);color:var(--btn-fg);text-decoration:none;font-weight:600}
</style></head><body><main><h1>Entre no Atlas para abrir esta prévia</h1>
<p>Este link só abre para quem está com a conta do Atlas conectada. Depois de entrar, volte a este link.</p>
<a href="/login">Entrar no Atlas</a></main></body></html>`;

/** `authLike` é injetável para o teste usar um servidor de autenticação com banco em memória. */
export function createRequireUser(authLike: Pick<typeof auth, "api">) {
	return createMiddleware<AuthEnv>(async (c, next) => {
		if (isPublicV1Request(c.req.method, c.req.path)) {
			await next();
			return;
		}

		const session = await authLike.api.getSession({ headers: c.req.raw.headers });
		if (!session || !isOwnerEmail(session.user.email)) {
			if (isPreviewOpenNavigation(c.req.method, c.req.path, c.req.header("accept"))) {
				return c.html(PREVIEW_LOGIN_PAGE, 401, {
					"Cache-Control": "no-store",
					"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				});
			}
			return c.json({ error: "Unauthorized" }, 401);
		}
		c.set("session", session);
		c.set("user", session.user);
		await next();
	});
}

export const requireUser = createRequireUser(auth);
