import { Hono } from "hono";
import { purchaseMandateInputSchema, validateSavedCardInput, type SavedCardSecrets, type SavedCardView, type CardBrand, CARD_BRANDS } from "@workspace/shared";
import { SavedCardLimitError, createSavedCard, deletePurchaseMandate, deleteSavedCard, getPurchaseMandate, listSavedCards, upsertPurchaseMandate, type PurchaseMandateRow, type SavedCardRow } from "@workspace/db";
import { isCardVaultConfigured, sealCardSecrets } from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Cartões salvos e mandato de compra (Motor v4, F6.2 e F6.4). Só o dono: o `userId` vem da sessão (`scopeFor`), nunca de
 * corpo, query ou parâmetro; cartão de outro usuário é 404 (igual a inexistente). Ambas exigem sessão (`requireUser`).
 *
 * REGRAS DO DONO (05/11): o CVV NUNCA é guardado e não existe campo para ele (corpo estrito: `cvv`/`cvc` = 400). Número,
 * nome, validade e endereço de cobrança vão selados (`secretsEnc`); NENHUMA resposta devolve esses dados, só rótulo,
 * bandeira e final. O corpo do cartão nunca é logado e o erro de validação nunca repete o que foi enviado.
 *
 * CONTRATO
 * 1. `GET /v1/cards` → 200 `{ configured, cards: [{ id, label, brand, last4, createdAt }] }`.
 * 2. `POST /v1/cards` body `SavedCardInput` (ver shared/payment-card.ts) → 201 `{ card }`.
 *    400 corpo inválido (Luhn, validade vencida, campo desconhecido). 409 limite de cartões. 503 cofre sem chave do servidor.
 * 3. `DELETE /v1/cards/:id` → 200 `{ ok: true }`. 404 inexistente ou de outro dono.
 * 4. `GET /v1/purchase-mandate` → 200 `{ mandate: { maxAmount, currency, merchants, until, usesLeft } | null }`.
 * 5. `PUT /v1/purchase-mandate` body `{ maxAmount, currency, merchants[], until, uses }` → 200 `{ mandate }` (substitui o anterior).
 *    O mandato só dispensa o "confirmar": o CVV continua sendo pedido a cada compra.
 * 6. `DELETE /v1/purchase-mandate` → 200 `{ ok: true }`; 404 se não havia.
 */
export type CardRouteDeps = {
	now(): Date;
	configured(): boolean;
	seal(secrets: SavedCardSecrets): string;
	create: typeof createSavedCard;
	list(userId: string): Promise<SavedCardRow[]>;
	remove(userId: string, id: string): Promise<boolean>;
	getMandate(userId: string): Promise<PurchaseMandateRow | null>;
	putMandate: typeof upsertPurchaseMandate;
	removeMandate(userId: string): Promise<boolean>;
};

const defaultDeps: CardRouteDeps = {
	now: () => new Date(),
	configured: () => isCardVaultConfigured(),
	seal: (secrets) => sealCardSecrets(secrets),
	create: createSavedCard,
	list: listSavedCards,
	remove: deleteSavedCard,
	getMandate: getPurchaseMandate,
	putMandate: upsertPurchaseMandate,
	removeMandate: deletePurchaseMandate,
};

const ID_MAX = 100;
const isBrand = (value: string): value is CardBrand => (CARD_BRANDS as readonly string[]).includes(value);

export function toCardView(row: SavedCardRow): SavedCardView {
	return { id: row.id, label: row.label, brand: isBrand(row.brand) ? row.brand : "unknown", last4: row.last4, createdAt: row.createdAt.toISOString() };
}

function toMandateView(row: PurchaseMandateRow) {
	return { maxAmount: row.maxAmount, currency: row.currency, merchants: row.merchants, until: row.until.toISOString(), usesLeft: row.usesLeft };
}

export function createCardRoutes(overrides: Partial<CardRouteDeps> = {}) {
	const deps = { ...defaultDeps, ...overrides };
	const app = new Hono<AuthEnv>();

	app.get("/v1/cards", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		return c.json({ configured: deps.configured(), cards: (await deps.list(userId)).map(toCardView) });
	});

	app.post("/v1/cards", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!deps.configured()) return c.json({ error: "card_vault_unavailable" }, 503);
		const checked = validateSavedCardInput(await c.req.json().catch(() => null), deps.now());
		// A mensagem é fixa por tipo de erro: nunca ecoa o que o dono digitou.
		if (!checked.ok) return c.json({ error: "invalid_card", message: checked.error }, 400);
		try {
			const row = await deps.create(userId, { label: checked.card.label, brand: checked.card.brand, last4: checked.card.last4, secretsEnc: deps.seal(checked.card.secrets) });
			return c.json({ card: toCardView(row) }, 201);
		} catch (error) {
			if (error instanceof SavedCardLimitError) return c.json({ error: "card_limit" }, 409);
			return c.json({ error: "card_vault_unavailable" }, 503);
		}
	});

	app.delete("/v1/cards/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const id = c.req.param("id");
		if (id.length === 0 || id.length > ID_MAX) return c.json({ error: "Not found" }, 404);
		if (!(await deps.remove(userId, id))) return c.json({ error: "Not found" }, 404);
		return c.json({ ok: true });
	});

	app.get("/v1/purchase-mandate", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const row = await deps.getMandate(userId);
		return c.json({ mandate: row ? toMandateView(row) : null });
	});

	app.put("/v1/purchase-mandate", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const parsed = purchaseMandateInputSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ error: "invalid_mandate" }, 400);
		const until = new Date(parsed.data.until);
		// Prazo no passado ou ilegível não cria mandato (e um prazo longo demais não é "delimitado").
		if (!Number.isFinite(until.getTime()) || until.getTime() <= deps.now().getTime() || until.getTime() > deps.now().getTime() + 366 * 24 * 60 * 60 * 1000) return c.json({ error: "invalid_mandate" }, 400);
		const row = await deps.putMandate(userId, { maxAmount: parsed.data.maxAmount, currency: parsed.data.currency, merchants: parsed.data.merchants, until, uses: parsed.data.uses });
		return c.json({ mandate: toMandateView(row) });
	});

	app.delete("/v1/purchase-mandate", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!(await deps.removeMandate(userId))) return c.json({ error: "Not found" }, 404);
		return c.json({ ok: true });
	});

	return app;
}
