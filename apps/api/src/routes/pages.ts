import { Hono } from "hono";
import { createOrRotatePageShare, deletePage, getPageForUser, getPageShareStatus, listBotPagesForUser, revokePageShare, setPageGroup } from "@workspace/db";
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
	moveToGroup?: typeof setPageGroup;
	shareStatus?: typeof getPageShareStatus;
	createShare?: typeof createOrRotatePageShare;
	revokeShare?: typeof revokePageShare;
};

/** Base pública do web (onde mora `/p/:token`): `ATLAS_URL`; sem ela (dev), a origem da própria requisição. */
function webBaseUrl(requestUrl: string): string {
	const configured = process.env.ATLAS_URL?.trim().replace(/\/$/, "");
	return configured || new URL(requestUrl).origin;
}

const NOT_FOUND = { error: "Page not found" } as const;

export function createPageRoutes(deps: PageRouteDeps = {}) {
	const app = new Hono<AuthEnv>();
	const getPage = deps.getPage ?? getPageForUser;
	const listBotPages = deps.listBotPages ?? listBotPagesForUser;
	const removePage = deps.removePage ?? deletePage;
	const moveToGroup = deps.moveToGroup ?? setPageGroup;
	const shareStatus = deps.shareStatus ?? getPageShareStatus;
	const createShare = deps.createShare ?? createOrRotatePageShare;
	const revokeShare = deps.revokeShare ?? revokePageShare;

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

	/**
	 * Move o painel para um grupo (o mesmo das rotinas) ou tira dele (`groupId: null`). O grupo precisa ser do mesmo
	 * dono e bot do painel; painel ou grupo de outro dono responde 404 igual a inexistente.
	 */
	app.patch("/v1/pages/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== "object" || !("groupId" in body)) return c.json({ error: "groupId is required (a group id or null)" }, 400);
		const groupId = body.groupId;
		if (groupId !== null && (typeof groupId !== "string" || !groupId.trim() || groupId.length > 100)) return c.json({ error: "groupId must be a group id or null" }, 400);
		const moved = await moveToGroup(c.req.param("id"), userId, groupId === null ? null : groupId.trim()).catch(() => null);
		if (!moved?.ok) return c.json(NOT_FOUND, 404);
		return c.json({ ok: true, id: moved.page.id, groupId: moved.page.groupId });
	});

	/** O link público do painel está ativo? Nunca devolve o token (só o hash existe no banco). */
	app.get("/v1/pages/:id/share", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const status = await shareStatus(c.req.param("id"), userId).catch(() => null);
		if (!status) return c.json(NOT_FOUND, 404);
		return c.json(status, 200, { "Cache-Control": "private, no-store" });
	});

	/** Cria o link público (ou gira o token: o antigo deixa de valer). A URL só aparece nesta resposta. */
	app.post("/v1/pages/:id/share", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const created = await createShare(c.req.param("id"), userId).catch(() => null);
		if (!created) return c.json(NOT_FOUND, 404);
		return c.json({ active: true, createdAt: created.createdAt, url: `${webBaseUrl(c.req.url)}/p/${created.token}` }, 200, { "Cache-Control": "private, no-store" });
	});

	/** Desativa o link público. Idempotente: sem link ativo também responde ok. */
	app.delete("/v1/pages/:id/share", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const revoked = await revokeShare(c.req.param("id"), userId).catch(() => null);
		if (revoked === null) return c.json(NOT_FOUND, 404);
		return c.json({ active: false, createdAt: null });
	});

	app.delete("/v1/pages/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const removed = await removePage(c.req.param("id"), userId).catch(() => false);
		if (!removed) return c.json(NOT_FOUND, 404);
		return c.json({ ok: true });
	});

	return app;
}
