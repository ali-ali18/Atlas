import { Hono } from "hono";
import { LESSON_MAX_CHARS, parseLessonRule, type LessonRule, type LessonView } from "@workspace/shared";
import { isBotOwnedBy, listBotLessons, restoreBotLessonVersion, retireBotLesson, setBotLessonRule, updateBotLessonContent } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/** Portas do banco (injetáveis nos testes). Toda porta recebe o `userId` da sessão. */
export type LessonRouteDeps = {
	botOwned(userId: string, botId: string): Promise<boolean>;
	list(userId: string, botId: string): Promise<LessonView[]>;
	edit(userId: string, lessonId: string, content: string): Promise<LessonView | null>;
	retire(userId: string, lessonId: string): Promise<LessonView | null>;
	restore(userId: string, lessonId: string): Promise<LessonView | null>;
	setRule(userId: string, lessonId: string, rule: LessonRule | null): Promise<LessonView | null>;
};

const defaultDeps: LessonRouteDeps = {
	botOwned: isBotOwnedBy,
	list: listBotLessons,
	edit: updateBotLessonContent,
	retire: retireBotLesson,
	restore: restoreBotLessonVersion,
	setRule: setBotLessonRule,
};

const NOT_FOUND = { error: "Lição não encontrada" } as const;

/**
 * Lições do bot (aba "Lições"). Só o dono: bot ou lição de outro usuário é 404 (nunca revela que existe). O
 * `userId` vem da sessão; as funções do db filtram por ele na própria consulta.
 */
export function createLessonRoutes(deps: LessonRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/lessons", async (c) => {
		const botId = c.req.query("botId")?.trim();
		if (!botId) return c.json({ error: "botId obrigatório" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			if (!(await deps.botOwned(userId, botId))) return c.json({ error: "Bot não encontrado" }, 404);
			return c.json({ lessons: await deps.list(userId, botId) });
		} catch (error) {
			console.error("list lessons failed", error);
			return c.json({ error: "Failed to load lessons" }, 503);
		}
	});

	app.patch("/v1/lessons/:id", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const content = typeof (body as { content?: unknown } | null)?.content === "string" ? ((body as { content: string }).content).replace(/\s+/g, " ").trim() : "";
		if (!content) return c.json({ error: "Escreva a lição antes de salvar." }, 400);
		if (content.length > LESSON_MAX_CHARS) return c.json({ error: `A lição pode ter até ${LESSON_MAX_CHARS} caracteres.` }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const lesson = await deps.edit(userId, c.req.param("id"), content);
			return lesson ? c.json({ lesson }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("edit lesson failed", error);
			return c.json({ error: "Failed to edit lesson" }, 503);
		}
	});

	app.delete("/v1/lessons/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const lesson = await deps.retire(userId, c.req.param("id"));
			return lesson ? c.json({ lesson }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("retire lesson failed", error);
			return c.json({ error: "Failed to remove lesson" }, 503);
		}
	});

	app.post("/v1/lessons/:id/restore", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const lesson = await deps.restore(userId, c.req.param("id"));
			return lesson ? c.json({ lesson }) : c.json({ error: "Não há versão anterior para restaurar" }, 404);
		} catch (error) {
			console.error("restore lesson failed", error);
			return c.json({ error: "Failed to restore lesson" }, 503);
		}
	});

	/**
	 * Regra da lição (hooks): o dono liga, troca ou tira. O formato é estrito e só aperta o comportamento
	 * (campos obrigatórios, chamada prévia, confirmar sempre); qualquer outra coisa é 400 com o motivo.
	 */
	app.put("/v1/lessons/:id/rule", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseLessonRule((body as { rule?: unknown } | null)?.rule, { userAuthored: true });
		if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const lesson = await deps.setRule(userId, c.req.param("id"), parsed.rule);
			return lesson ? c.json({ lesson }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("set lesson rule failed", error);
			return c.json({ error: "Failed to save rule" }, 503);
		}
	});

	app.delete("/v1/lessons/:id/rule", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const lesson = await deps.setRule(userId, c.req.param("id"), null);
			return lesson ? c.json({ lesson }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("clear lesson rule failed", error);
			return c.json({ error: "Failed to remove rule" }, 503);
		}
	});

	return app;
}
