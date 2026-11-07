import { Hono } from "hono";
import {
	isEngineV4Enabled,
	parseAgendaChangeBody,
	readEngineV4Gate,
	toAgendaItemView,
	type AgendaAction,
	type AgendaChangeResponse,
	type AgendaListResponse,
	type EngineV4Gate,
} from "@workspace/shared";
import { changeAgendaItem, getAgendaItem, isBotOwnedBy, listAgendaItems, listEndedAgendaItems, loadAgendaSettings, type AgendaItemRecord } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Agenda do agente na Biblioteca (Motor v4, F4.4). Só o dono: o `userId` vem da sessão (`scopeFor`), nunca de corpo, query
 * ou parâmetro; item ou bot de outro usuário é 404 (igual a inexistente). Só existe com `ATLAS_ENGINE_V4` ligada E a conta
 * em `ATLAS_ENGINE_V4_ACCOUNTS` (a mesma regra do worker): fora disso a lista diz `enabled: false` (a tela esconde a seção)
 * e a mudança é 404.
 *
 * CONTRATO (tipos em `packages/shared/src/agenda-view.ts`; ambas exigem sessão, `requireUser`):
 *
 * 1. `GET /v1/agenda?botId=<id>`
 *    - `botId` opcional (sem ele, os itens de todos os bots do dono); bot de outro dono = 404.
 *    - 200 `{ enabled, timezone, items, ended }`. `items` = lembretes, vigias e intenções ativos ou pausados (próximos
 *      primeiro); `ended` = os últimos encerrados (até 10). Conta sem o v4: `{ enabled: false, timezone: "", items: [], ended: [] }`
 *      sem consultar o banco. Nenhum campo interno (permissão, run, conversa, memo) sobe.
 *    - 503 falha ao ler.
 *
 * 2. `POST /v1/agenda/:id`  body `{ "action": "pause" | "resume" | "cancel" }` (campo desconhecido = 400)
 *    - 200 `{ item }` com o item já no novo estado.
 *    - 400 corpo inválido. 404 item inexistente, de outro dono ou conta sem o v4.
 *    - 409 a ação não cabe no estado atual (ex.: retomar o que já está ativo, mexer no que acabou).
 *    - 503 falha ao gravar.
 */
export type AgendaRouteDeps = {
	gate(): EngineV4Gate;
	botOwned(userId: string, botId: string): Promise<boolean>;
	list(userId: string, options: { botId?: string; includeEnded?: boolean; limit?: number }): Promise<AgendaItemRecord[]>;
	/** Os encerrados mais recentes primeiro (consulta própria, ordenada por encerramento). */
	listEnded(userId: string, options: { botId?: string; limit?: number }): Promise<AgendaItemRecord[]>;
	get(userId: string, id: string): Promise<AgendaItemRecord | null>;
	change(userId: string, id: string, action: AgendaAction): Promise<AgendaItemRecord | null>;
	timezone(userId: string, botId: string): Promise<string>;
};

const defaultDeps: AgendaRouteDeps = {
	gate: () => readEngineV4Gate(process.env.ATLAS_ENGINE_V4, process.env.ATLAS_ENGINE_V4_ACCOUNTS),
	botOwned: isBotOwnedBy,
	list: listAgendaItems,
	listEnded: listEndedAgendaItems,
	get: getAgendaItem,
	change: (userId, id, action) => changeAgendaItem(userId, id, action),
	timezone: async (userId, botId) => (await loadAgendaSettings(userId, botId)).timezone,
};

/** Quantos itens encerrados a Biblioteca mostra. */
const ENDED_SHOWN = 10;

const NOT_FOUND = { error: "Not found" } as const;
const idParam = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 64 ? trimmed : undefined;
};

/** Ativos: o que vence primeiro vem primeiro; quem espera evento (sem horário próprio) fica depois, por vigência. */
function byUpcoming(a: AgendaItemRecord, b: AgendaItemRecord): number {
	const rank = (item: AgendaItemRecord) => (item.status === "paused" ? 1 : 0);
	return rank(a) - rank(b) || a.dueAt.getTime() - b.dueAt.getTime();
}

export function createAgendaRoutes(deps: AgendaRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/agenda", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const empty: AgendaListResponse = { enabled: false, timezone: "", items: [], ended: [] };
		if (!isEngineV4Enabled(deps.gate(), userId)) return c.json(empty);
		const rawBot = c.req.query("botId");
		const botId = idParam(rawBot);
		if (rawBot !== undefined && !botId) return c.json(NOT_FOUND, 404);
		try {
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(NOT_FOUND, 404);
			const [active, ended, timezone] = await Promise.all([
				deps.list(userId, { ...(botId && { botId }), limit: 100 }),
				deps.listEnded(userId, { ...(botId && { botId }), limit: ENDED_SHOWN }),
				deps.timezone(userId, botId ?? ""),
			]);
			const body: AgendaListResponse = { enabled: true, timezone, items: [...active].sort(byUpcoming).map(toAgendaItemView), ended: ended.map(toAgendaItemView) };
			return c.json(body);
		} catch (error) {
			console.error("list agenda failed", error);
			return c.json({ error: "Failed to load agenda" }, 503);
		}
	});

	app.post("/v1/agenda/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const id = idParam(c.req.param("id"));
		if (!id || !isEngineV4Enabled(deps.gate(), userId)) return c.json(NOT_FOUND, 404);
		const body = parseAgendaChangeBody(await c.req.json().catch(() => null));
		if (!body.ok) return c.json({ error: body.error }, 400);
		try {
			// Filtra pelo dono na consulta: item alheio é 404 antes de qualquer escrita.
			if (!(await deps.get(userId, id))) return c.json(NOT_FOUND, 404);
			const changed = await deps.change(userId, id, body.action);
			if (!changed) return c.json({ error: "Action does not fit the item's current state", code: "invalid_state" }, 409);
			const response: AgendaChangeResponse = { item: toAgendaItemView(changed) };
			return c.json(response);
		} catch (error) {
			console.error("change agenda item failed", error);
			return c.json({ error: "Failed to update agenda item" }, 503);
		}
	});

	return app;
}
