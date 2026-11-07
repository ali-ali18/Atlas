import { Hono } from "hono";
import type { MemoryChangesPage, SleepReportKind, SleepReportView } from "@workspace/shared";
import { SLEEP_REPORT_KINDS } from "@workspace/shared";
import { dismissSleepProposal, getSleepReport, isBotOwnedBy, listSleepChanges, listSleepReports } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/** Portas do banco (injetáveis nos testes). Toda porta recebe o `userId` da sessão e filtra por ele. */
export type SleepRouteDeps = {
	botOwned(userId: string, botId: string): Promise<boolean>;
	reports(input: { userId: string; botId?: string; kind?: SleepReportKind; cursor?: string; limit?: number }): Promise<{ reports: SleepReportView[]; nextCursor: string | null }>;
	report(userId: string, id: string): Promise<SleepReportView | null>;
	dismiss(input: { userId: string; reportId: string; proposalId: string }): Promise<SleepReportView | null>;
	changes(input: { userId: string; botId?: string; reportId?: string; cursor?: string; limit?: number }): Promise<MemoryChangesPage>;
};

const defaultDeps: SleepRouteDeps = { botOwned: isBotOwnedBy, reports: listSleepReports, report: getSleepReport, dismiss: dismissSleepProposal, changes: listSleepChanges };

const BOT_NOT_FOUND = { error: "Bot não encontrado" } as const;
const REPORT_NOT_FOUND = { error: "Relatório não encontrado" } as const;
const idParam = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 64 ? trimmed : undefined;
};
const limitParam = (value: string | undefined): number | undefined => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Sono do bot (F5.3): o que o bot guardou à noite, as propostas (habilidades, casos de eval, achados do "doctor") e o
 * desfazer. Só o dono: o `userId` vem da sessão; relatório ou bot de outro usuário é 404. O desfazer de cada mudança é
 * `POST /v1/memory/changes/:id/undo` (a lista abaixo traz os ids), que recusa com 409 se o item mudou depois.
 */
export function createSleepRoutes(deps: SleepRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/sleep/reports", async (c) => {
		const botId = idParam(c.req.query("botId"));
		const kindRaw = c.req.query("kind");
		const kind = (SLEEP_REPORT_KINDS as readonly string[]).includes(kindRaw ?? "") ? (kindRaw as SleepReportKind) : undefined;
		if (kindRaw && !kind) return c.json({ error: `kind inválido (${SLEEP_REPORT_KINDS.join(", ")})` }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(BOT_NOT_FOUND, 404);
			const cursor = idParam(c.req.query("cursor"));
			const limit = limitParam(c.req.query("limit"));
			return c.json(await deps.reports({ userId, ...(botId && { botId }), ...(kind && { kind }), ...(cursor && { cursor }), ...(limit && { limit }) }));
		} catch (error) {
			console.error("list sleep reports failed", error);
			return c.json({ error: "Failed to load sleep reports" }, 503);
		}
	});

	// Antes de `/v1/sleep/reports/:id` não conflita (caminhos diferentes), mas fica junto das listas.
	app.get("/v1/sleep/changes", async (c) => {
		const botId = idParam(c.req.query("botId"));
		const reportId = idParam(c.req.query("reportId"));
		try {
			const { userId } = scopeFor(c.get("session"));
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(BOT_NOT_FOUND, 404);
			const cursor = idParam(c.req.query("cursor"));
			const limit = limitParam(c.req.query("limit"));
			return c.json(await deps.changes({ userId, ...(botId && { botId }), ...(reportId && { reportId }), ...(cursor && { cursor }), ...(limit && { limit }) }));
		} catch (error) {
			console.error("list sleep changes failed", error);
			return c.json({ error: "Failed to load sleep changes" }, 503);
		}
	});

	app.get("/v1/sleep/reports/:id", async (c) => {
		const id = idParam(c.req.param("id"));
		if (!id) return c.json(REPORT_NOT_FOUND, 404);
		try {
			const { userId } = scopeFor(c.get("session"));
			const report = await deps.report(userId, id);
			return report ? c.json({ report }) : c.json(REPORT_NOT_FOUND, 404);
		} catch (error) {
			console.error("get sleep report failed", error);
			return c.json({ error: "Failed to load sleep report" }, 503);
		}
	});

	/** O dono dispensa uma proposta (habilidade, caso de eval, achado do doctor). Nada é aplicado sem ele. */
	app.post("/v1/sleep/reports/:id/proposals/:proposalId/dismiss", async (c) => {
		const reportId = idParam(c.req.param("id"));
		const proposalId = idParam(c.req.param("proposalId"));
		if (!reportId || !proposalId) return c.json(REPORT_NOT_FOUND, 404);
		try {
			const { userId } = scopeFor(c.get("session"));
			const report = await deps.dismiss({ userId, reportId, proposalId });
			return report ? c.json({ report }) : c.json({ error: "Proposta não encontrada" }, 404);
		} catch (error) {
			console.error("dismiss sleep proposal failed", error);
			return c.json({ error: "Failed to dismiss proposal" }, 503);
		}
	});

	return app;
}
