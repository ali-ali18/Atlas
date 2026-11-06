import { Hono } from "hono";
import { OWNER_NOTES_MAX_PER_OWNER, parseCreateOwnerNote, parseUpdateOwnerNote, type MemoryChangesPage, type OwnerNoteView } from "@workspace/shared";
import { createNote, deleteNote, getNote, isBotOwnedBy, listNoteChanges, listNotes, updateNote, type NoteResult } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/** Portas do banco (injetáveis nos testes). Toda porta recebe o `userId` da sessão e filtra por ele. */
export type NoteRouteDeps = {
	botOwned(userId: string, botId: string): Promise<boolean>;
	list(input: { userId: string; botId?: string; pinnedOnly?: boolean }): Promise<OwnerNoteView[]>;
	get(userId: string, id: string): Promise<OwnerNoteView | null>;
	create(input: { userId: string; botId: string | null; title: string; body: string; pinned?: boolean }): Promise<NoteResult>;
	update(input: { userId: string; id: string; patch: { title?: string; body?: string; pinned?: boolean } }): Promise<NoteResult | null>;
	remove(userId: string, id: string): Promise<boolean>;
	changes(input: { userId: string; botId?: string; cursor?: string; limit?: number }): Promise<MemoryChangesPage>;
};

const defaultDeps: NoteRouteDeps = {
	botOwned: isBotOwnedBy,
	list: (input) => listNotes(input),
	get: (userId, id) => getNote(userId, id),
	create: (input) => createNote({ ...input, origin: "user" }),
	update: (input) => updateNote({ ...input, origin: "user" }),
	remove: (userId, id) => deleteNote({ userId, id, origin: "user" }),
	changes: (input) => listNoteChanges(input),
};

const NOT_FOUND = { error: "Nota não encontrada" } as const;
const BOT_NOT_FOUND = { error: "Bot não encontrado" } as const;

const idParam = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 64 ? trimmed : undefined;
};

function failure(c: { json: (body: unknown, status: 409) => Response }, result: Extract<NoteResult, { ok: false }>): Response {
	return c.json({ error: result.message, code: result.code, ...(result.existingId && { existingId: result.existingId }) }, 409);
}

/**
 * Caderno do dono (F5.1). Só o dono: o `userId` vem da sessão (`scopeFor`), nunca de corpo, query ou parâmetro; nota ou
 * bot de outro usuário é 404 (nunca revela que existe). O corpo é validado de forma estrita (campo desconhecido = 400).
 * O desfazer das mudanças usa `POST /v1/memory/changes/:id/undo`, que também conhece as notas.
 */
export function createNoteRoutes(deps: NoteRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	/** `?botId=` restringe a visão a "notas do dono + as deste bot". Sem ele, todas as do dono. */
	app.get("/v1/notes", async (c) => {
		const botId = idParam(c.req.query("botId"));
		try {
			const { userId } = scopeFor(c.get("session"));
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(BOT_NOT_FOUND, 404);
			const notes = await deps.list({ userId, ...(botId && { botId }), pinnedOnly: c.req.query("pinned") === "true" });
			return c.json({ notes, limit: OWNER_NOTES_MAX_PER_OWNER });
		} catch (error) {
			console.error("list notes failed", error);
			return c.json({ error: "Failed to load notes" }, 503);
		}
	});

	// Antes de `/v1/notes/:id` para "changes" não ser lido como id.
	app.get("/v1/notes/changes", async (c) => {
		const botId = idParam(c.req.query("botId"));
		const cursor = idParam(c.req.query("cursor"));
		const limit = Number(c.req.query("limit"));
		try {
			const { userId } = scopeFor(c.get("session"));
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(BOT_NOT_FOUND, 404);
			return c.json(await deps.changes({ userId, ...(botId && { botId }), ...(cursor && { cursor }), ...(Number.isFinite(limit) && limit > 0 && { limit }) }));
		} catch (error) {
			console.error("list note changes failed", error);
			return c.json({ error: "Failed to load note changes" }, 503);
		}
	});

	app.get("/v1/notes/:id", async (c) => {
		const id = idParam(c.req.param("id"));
		if (!id) return c.json(NOT_FOUND, 404);
		try {
			const { userId } = scopeFor(c.get("session"));
			const note = await deps.get(userId, id);
			return note ? c.json({ note }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("get note failed", error);
			return c.json({ error: "Failed to load note" }, 503);
		}
	});

	app.post("/v1/notes", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseCreateOwnerNote(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const { title, body: text, pinned, botId } = parsed.value;
		try {
			const { userId } = scopeFor(c.get("session"));
			if (botId && !(await deps.botOwned(userId, botId))) return c.json(BOT_NOT_FOUND, 404);
			const result = await deps.create({ userId, botId: botId ?? null, title, body: text, ...(pinned !== undefined && { pinned }) });
			return result.ok ? c.json({ note: result.note }, 201) : failure(c, result);
		} catch (error) {
			console.error("create note failed", error);
			return c.json({ error: "Failed to create note" }, 503);
		}
	});

	/** Edita título, texto e/ou `pinned` (é assim que o dono fixa e desafixa). O escopo (bot) não muda depois de criada. */
	app.patch("/v1/notes/:id", async (c) => {
		const id = idParam(c.req.param("id"));
		if (!id) return c.json(NOT_FOUND, 404);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseUpdateOwnerNote(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.update({ userId, id, patch: parsed.value });
			if (!result) return c.json(NOT_FOUND, 404);
			return result.ok ? c.json({ note: result.note }) : failure(c, result);
		} catch (error) {
			console.error("update note failed", error);
			return c.json({ error: "Failed to update note" }, 503);
		}
	});

	app.delete("/v1/notes/:id", async (c) => {
		const id = idParam(c.req.param("id"));
		if (!id) return c.json(NOT_FOUND, 404);
		try {
			const { userId } = scopeFor(c.get("session"));
			return (await deps.remove(userId, id)) ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			console.error("delete note failed", error);
			return c.json({ error: "Failed to delete note" }, 503);
		}
	});

	return app;
}
