import { Hono } from "hono";
import { getPurchase, isBotOwnedBy, listPurchases, type PurchaseRecord } from "@workspace/db";
import type { PurchaseView } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Compras registradas pelo bot (Motor v4, F6.5), só leitura. O `userId` vem da sessão (`scopeFor`), nunca de corpo, query ou
 * parâmetro; compra ou bot de outro usuário é 404 (igual a inexistente). Não há escrita aqui: quem grava é a tool
 * `record_purchase` do agente, e a conversa mostra o cartão.
 *
 * 1. `GET /v1/purchases?botId=<id>&limit=<1..100>` → 200 `{ purchases: PurchaseView[] }` (mais recente primeiro).
 *    `botId` opcional; bot de outro dono = 404. 503 falha ao ler.
 * 2. `GET /v1/purchases/:id` → 200 `{ purchase }`; 404 inexistente ou de outro dono.
 *
 * Nenhum campo interno sobe (id do vigia, chave de dedupe, run).
 */
export type PurchaseRouteDeps = {
	botOwned(userId: string, botId: string): Promise<boolean>;
	list(userId: string, options: { botId?: string; limit?: number }): Promise<PurchaseRecord[]>;
	get(userId: string, id: string): Promise<PurchaseRecord | null>;
};

const defaultDeps: PurchaseRouteDeps = { botOwned: isBotOwnedBy, list: listPurchases, get: getPurchase };

const NOT_FOUND = { error: "Not found" } as const;
const idParam = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 64 ? trimmed : undefined;
};
const view = ({ deliveryWatchId: _watch, ...rest }: PurchaseRecord): PurchaseView => {
	void _watch;
	return rest;
};

export function createPurchaseRoutes(deps: PurchaseRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/purchases", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const rawBot = c.req.query("botId");
		const botId = idParam(rawBot);
		if (rawBot !== undefined && !botId) return c.json(NOT_FOUND, 404);
		const rawLimit = c.req.query("limit");
		const limit = rawLimit === undefined ? 50 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: "limit must be a whole number from 1 to 100" }, 400);
		try {
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(NOT_FOUND, 404);
			const rows = await deps.list(userId, { ...(botId && { botId }), limit });
			return c.json({ purchases: rows.map(view) });
		} catch (error) {
			console.error("list purchases failed", error);
			return c.json({ error: "Failed to load purchases" }, 503);
		}
	});

	app.get("/v1/purchases/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const id = idParam(c.req.param("id"));
		if (!id) return c.json(NOT_FOUND, 404);
		try {
			const row = await deps.get(userId, id);
			return row ? c.json({ purchase: view(row) }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("get purchase failed", error);
			return c.json({ error: "Failed to load purchase" }, 503);
		}
	});

	return app;
}
