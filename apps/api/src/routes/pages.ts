import { Hono } from "hono";
import { deletePage, getPageForUser, listBotPagesForUser } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Páginas vivas (relatório/painel inline no chat). Sempre autenticado e escopado pelo dono da sessão:
 * página ou bot de outro usuário responde 404 (não revela que existe). Criar e atualizar é do agente (tools
 * `page_*`); aqui o usuário lê, lista e apaga.
 */

export type PageRouteDeps = {
	getPage?: typeof getPageForUser;
	listBotPages?: typeof listBotPagesForUser;
	removePage?: typeof deletePage;
};

const NOT_FOUND = { error: "Page not found" } as const;

export function createPageRoutes(deps: PageRouteDeps = {}) {
	const app = new Hono<AuthEnv>();
	const getPage = deps.getPage ?? getPageForUser;
	const listBotPages = deps.listBotPages ?? listBotPagesForUser;
	const removePage = deps.removePage ?? deletePage;

	/** Páginas do bot (mais recentes primeiro), só do dono; bot de outro dono = 404. */
	app.get("/v1/bots/:botId/pages", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const limitRaw = c.req.query("limit");
		const limit = limitRaw === undefined ? undefined : Number(limitRaw);
		if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) return c.json({ error: "Invalid limit" }, 400);
		try {
			const items = await listBotPages(userId, c.req.param("botId"), limit);
			if (!items) return c.json({ error: "Bot not found" }, 404);
			return c.json({ items });
		} catch (error) {
			console.error("list bot pages failed", error);
			return c.json({ error: "Failed to list pages" }, 503);
		}
	});

	app.get("/v1/pages/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const page = await getPage(c.req.param("id"), userId).catch(() => null);
		if (!page) return c.json(NOT_FOUND, 404);
		return c.json({ page }, 200, { "Cache-Control": "private, no-store" });
	});

	app.delete("/v1/pages/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const removed = await removePage(c.req.param("id"), userId).catch(() => false);
		if (!removed) return c.json(NOT_FOUND, 404);
		return c.json({ ok: true });
	});

	return app;
}
