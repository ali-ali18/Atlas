import { Hono } from "hono";
import { getSharedPageByToken } from "@workspace/db";

/**
 * Painel compartilhado por link público, somente leitura. SEM sessão: a autorização é o token da URL (256 bits;
 * o banco guarda só o hash). Devolve apenas o que desenha o painel (título, resumo, spec, data e nome do bot):
 * nada de dono, conversa nem fontes. Revogado, apagado ou desconhecido responde o mesmo 404. Mostra a revisão
 * mais recente a cada leitura ("ao vivo"), por isso sem cache.
 */

export type PublicPageRouteDeps = { getShared?: typeof getSharedPageByToken };

export function createPublicPageRoutes(deps: PublicPageRouteDeps = {}) {
	const app = new Hono();
	const getShared = deps.getShared ?? getSharedPageByToken;

	app.get("/v1/public/paineis/:token", async (c) => {
		const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
		const page = await getShared(c.req.param("token")).catch(() => null);
		if (!page) return c.json({ error: "Page not found" }, 404, headers);
		return c.json({ page }, 200, headers);
	});

	return app;
}
