import { Hono } from "hono";
import { CONNECTOR_GUIDE_MAX_CHARS, sanitizeGuideText, type ConnectorKind } from "@workspace/shared";
import { getConnectorGuide, resolveGuideSuggestion, setConnectorGuide } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { connectorGuideQueueReady, enqueueConnectorGuide } from "../connector-guide-queue.js";

/**
 * Guia de uso do conector (MCP e API): ler, editar, gerar de novo e tratar as
 * sugestões do bot. Tudo escopado ao dono da sessão (outro dono = 404). O texto é
 * dado do usuário/gerador; nunca vira instrução de sistema.
 */

function kindOf(raw: string): ConnectorKind | null {
	return raw === "mcp" || raw === "api" ? raw : null;
}

export function createConnectorGuideRoutes() {
	const app = new Hono<AuthEnv>();
	const base = "/v1/connectors/:kind/:id/guide";

	app.get(base, async (c) => {
		const kind = kindOf(c.req.param("kind"));
		if (!kind) return c.json({ error: "Tipo inválido" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await getConnectorGuide(kind, c.req.param("id"), userId);
			if (!result.found) return c.json({ error: "Conexão não encontrada" }, 404);
			return c.json({ guide: result.guide });
		} catch {
			return c.json({ error: "Não foi possível ler o guia" }, 503);
		}
	});

	app.put(base, async (c) => {
		const kind = kindOf(c.req.param("kind"));
		if (!kind) return c.json({ error: "Tipo inválido" }, 400);
		let body: unknown;
		try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
		const text = typeof (body as { text?: unknown } | null)?.text === "string" ? ((body as { text: string }).text) : null;
		if (text === null || !text.trim()) return c.json({ error: "Escreva o guia" }, 400);
		if (text.length > CONNECTOR_GUIDE_MAX_CHARS) return c.json({ error: `O guia pode ter até ${CONNECTOR_GUIDE_MAX_CHARS} caracteres` }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const guide = await setConnectorGuide(kind, c.req.param("id"), userId, { text: sanitizeGuideText(text), source: "user", force: true });
			if (!guide) return c.json({ error: "Conexão não encontrada" }, 404);
			return c.json({ guide });
		} catch {
			return c.json({ error: "Não foi possível salvar o guia" }, 503);
		}
	});

	/** Gera de novo em segundo plano. Guia editado só é sobrescrito com `confirm: true`. */
	app.post(`${base}/regenerate`, async (c) => {
		const kind = kindOf(c.req.param("kind"));
		if (!kind) return c.json({ error: "Tipo inválido" }, 400);
		let body: unknown = null;
		try { body = await c.req.json(); } catch { /* corpo opcional */ }
		const confirm = (body as { confirm?: unknown } | null)?.confirm === true;
		try {
			const { userId } = scopeFor(c.get("session"));
			const id = c.req.param("id");
			const current = await getConnectorGuide(kind, id, userId);
			if (!current.found) return c.json({ error: "Conexão não encontrada" }, 404);
			if (current.guide?.source === "user" && current.guide.text.trim() && !confirm) {
				return c.json({ error: "O guia foi editado por você; confirme para sobrescrever", code: "confirm_required" }, 409);
			}
			if (!connectorGuideQueueReady()) return c.json({ error: "Geração indisponível agora" }, 503);
			const queued = await enqueueConnectorGuide({ kind, connectionId: id, userId, force: true });
			if (!queued) return c.json({ error: "Não foi possível iniciar a geração" }, 503);
			return c.json({ queued: true }, 202);
		} catch {
			return c.json({ error: "Não foi possível iniciar a geração" }, 503);
		}
	});

	const resolve = (action: "accept" | "dismiss") => async (c: import("hono").Context<AuthEnv>) => {
		const kind = kindOf(c.req.param("kind") ?? "");
		if (!kind) return c.json({ error: "Tipo inválido" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await resolveGuideSuggestion(kind, c.req.param("id") ?? "", userId, c.req.param("sid") ?? "", action);
			if (!result.ok) {
				if (result.reason === "guide_full") return c.json({ error: `Não cabe no limite de ${CONNECTOR_GUIDE_MAX_CHARS} caracteres; edite o guia antes`, code: "guide_full" }, 409);
				return c.json({ error: "Sugestão não encontrada" }, 404);
			}
			return c.json({ guide: result.guide });
		} catch {
			return c.json({ error: "Não foi possível atualizar a sugestão" }, 503);
		}
	};
	app.post(`${base}/suggestions/:sid/accept`, resolve("accept"));
	app.post(`${base}/suggestions/:sid/dismiss`, resolve("dismiss"));

	return app;
}
