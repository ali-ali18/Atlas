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

function isPublicV1Request(method: string, path: string): boolean {
	// Webhook do GitHub App: sem sessão; autentica pela assinatura HMAC (X-Hub-Signature-256).
	if (method === "POST" && path === "/v1/github-app/webhook") return true;
	// Entrada de e-mail do bot: sem sessão; autentica pelo token da URL + assinatura HMAC do provedor.
	if ((method === "POST" || method === "GET") && /^\/v1\/email\/inbound\/[^/]+$/.test(path)) return true;
	// Ícone de notificação push (PNG do avatar): público, a chave só tem forma e cor.
	if (method === "GET" && path.startsWith("/v1/avatars/") && !path.slice(12).includes("/")) return true;
	// Aviso de fim de job do container da sessão: autentica por HMAC do token da sessão (rota dev-job-callback).
	if (method === "POST" && path === "/v1/internal/dev-jobs/callback") return true;
	if (method === "POST" && /^\/v1\/hooks\/[^/]+(?:\/[^/]+)?$/.test(path)) return true;
	// GET só responde a dica "use POST" (405), igual para qualquer hookKey.
	if (method === "GET" && /^\/v1\/hooks\/[^/]+$/.test(path)) return true;
	return false;
}

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
	if (isPublicV1Request(c.req.method, c.req.path)) {
		await next();
		return;
	}

	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session || !isOwnerEmail(session.user.email)) return c.json({ error: "Unauthorized" }, 401);
	c.set("session", session);
	c.set("user", session.user);
	await next();
});
