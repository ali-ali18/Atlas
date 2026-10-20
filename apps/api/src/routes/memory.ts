import { Hono } from "hono";
import type {
	MemoryActionResult,
	MemoryCleanupJobPayload,
	MemoryCleanupSuggestion,
	MemoryCleanupView,
	MemoryChangesPage,
	MemorySnapshot,
	MemoryAddInput,
	MemoryRemoveInput,
	MemoryReplaceInput,
	MemoryTarget,
} from "@workspace/shared";
import {
	addMemoryEntry,
	getMemoryCleanup,
	getMemorySnapshot,
	isBotOwnedBy,
	listMemoryChanges,
	memoryRef,
	mergeMemoryEntries,
	removeMemoryEntry,
	removeMemoryEntryById,
	replaceMemoryEntry,
	replaceMemoryEntryById,
	setMemoryCleanupSuggestions,
	undoMemoryChange,
	type MemoryUndoResult,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { enqueueMemoryCleanup } from "../memory-cleanup-queue.js";

const TARGETS: readonly MemoryTarget[] = ["user", "memory"];

function parseTarget(value: unknown): MemoryTarget | null {
	return typeof value === "string" &&
		(TARGETS as readonly string[]).includes(value)
		? (value as MemoryTarget)
		: null;
}

function parseBotId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function parseAddInput(body: unknown): MemoryAddInput | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const { target, content, botId } = body as {
		target?: unknown;
		content?: unknown;
		botId?: unknown;
	};
	const parsedTarget = parseTarget(target);
	if (!parsedTarget) {
		return null;
	}
	if (typeof content !== "string" || content.trim().length === 0) {
		return null;
	}
	return {
		target: parsedTarget,
		content: content.trim(),
		botId: parseBotId(botId),
	};
}

function parseReplaceInput(body: unknown): MemoryReplaceInput | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const { target, oldText, content, botId } = body as {
		target?: unknown;
		oldText?: unknown;
		content?: unknown;
		botId?: unknown;
	};
	const parsedTarget = parseTarget(target);
	if (!parsedTarget) {
		return null;
	}
	if (typeof oldText !== "string" || oldText.trim().length === 0) {
		return null;
	}
	if (typeof content !== "string" || content.trim().length === 0) {
		return null;
	}
	return {
		target: parsedTarget,
		oldText: oldText.trim(),
		content: content.trim(),
		botId: parseBotId(botId),
	};
}

function parseRemoveInput(body: unknown): MemoryRemoveInput | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const { target, oldText, botId } = body as {
		target?: unknown;
		oldText?: unknown;
		botId?: unknown;
	};
	const parsedTarget = parseTarget(target);
	if (!parsedTarget) {
		return null;
	}
	if (typeof oldText !== "string" || oldText.trim().length === 0) {
		return null;
	}
	return {
		target: parsedTarget,
		oldText: oldText.trim(),
		botId: parseBotId(botId),
	};
}

function actionStatus(result: MemoryActionResult): number {
	if (result.ok) {
		return 200;
	}
	return result.error === "duplicado" ? 409 : 400;
}

/** Mensagem pt-BR para a falha de uma escrita (a UI mostra isto inline). */
export function memoryErrorMessage(error: string): string {
	if (error === "duplicado") return "Essa memória já existe.";
	if (error === "conteúdo vazio") return "Escreva algo antes de salvar.";
	if (error.startsWith("limite de")) return "A memória está cheia. Apague algo antes de guardar mais.";
	if (error.startsWith("conteúdo bloqueado")) return "Esse texto foi bloqueado pela verificação de segurança.";
	return "Não foi possível salvar essa memória.";
}

function parseContent(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const { content } = body as { content?: unknown };
	return typeof content === "string" && content.trim().length > 0 ? content.trim() : null;
}

function parseLimit(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Portas do banco (injetáveis nos testes). */
export type MemoryRouteDeps = {
	botOwned(userId: string, botId: string): Promise<boolean>;
	snapshot(userId: string, botId?: string): Promise<MemorySnapshot>;
	add: typeof addMemoryEntry;
	replace: typeof replaceMemoryEntry;
	remove: typeof removeMemoryEntry;
	editById: typeof replaceMemoryEntryById;
	removeById: typeof removeMemoryEntryById;
	listChanges(input: { userId: string; botId?: string; cursor?: string; limit?: number }): Promise<MemoryChangesPage>;
	undo(input: { userId: string; changeId: string }): Promise<MemoryUndoResult>;
	/** Limpeza com aprovação (opcional nos testes que não a exercitam). */
	cleanup?: MemoryCleanupPorts;
};

/** Portas da limpeza: leitura/gravação das sugestões, o job e as duas operações que a aprovação executa. */
export type MemoryCleanupPorts = {
	get(userId: string, botId: string): Promise<MemoryCleanupView | null>;
	save(userId: string, botId: string, list: MemoryCleanupSuggestion[]): Promise<MemoryCleanupView | null>;
	enqueue(payload: MemoryCleanupJobPayload): Promise<boolean>;
	removeById: typeof removeMemoryEntryById;
	merge: typeof mergeMemoryEntries;
};

const defaultCleanup: MemoryCleanupPorts = {
	get: getMemoryCleanup,
	save: setMemoryCleanupSuggestions,
	enqueue: enqueueMemoryCleanup,
	removeById: removeMemoryEntryById,
	merge: mergeMemoryEntries,
};

/** Executa UMA sugestão aprovada pelo usuário. `false` = não vale mais (entradas mudaram ou sumiram). */
async function applySuggestion(ports: MemoryCleanupPorts, userId: string, botId: string, suggestion: MemoryCleanupSuggestion): Promise<boolean> {
	if (suggestion.kind === "delete") {
		let removed = 0;
		for (const entryId of suggestion.entryIds) {
			const result = await ports.removeById({ userId, entryId, origin: "user" });
			if (result?.ok) removed += 1;
		}
		return removed > 0;
	}
	const result = await ports.merge({ userId, botId, target: suggestion.target, refs: suggestion.entryIds.map(memoryRef), content: suggestion.content ?? "", origin: "user" });
	return result.ok;
}

const defaultDeps: MemoryRouteDeps = {
	botOwned: isBotOwnedBy,
	snapshot: getMemorySnapshot,
	add: addMemoryEntry,
	replace: replaceMemoryEntry,
	remove: removeMemoryEntry,
	editById: replaceMemoryEntryById,
	removeById: removeMemoryEntryById,
	listChanges: listMemoryChanges,
	undo: undoMemoryChange,
};

export function createMemoryRoutes(deps: MemoryRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	/** Bot informado que não é do usuário vira 404 (nunca revela que existe). */
	async function botMissing(userId: string, botId: string | undefined): Promise<boolean> {
		return botId !== undefined && !(await deps.botOwned(userId, botId));
	}

	app.get("/v1/memory", async (c) => {
		const botId = parseBotId(c.req.query("botId"));
		try {
			const { userId } = scopeFor(c.get("session"));
			if (await botMissing(userId, botId)) return c.json({ error: "Bot não encontrado" }, 404);
			const snapshot = await deps.snapshot(userId, botId);
			return c.json({ snapshot });
		} catch (error) {
			console.error("load memory snapshot failed", error);
			return c.json({ error: "Failed to load memory" }, 503);
		}
	});

	app.post("/v1/memory", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const input = parseAddInput(json);
		if (!input) {
			return c.json(
				{
					error:
						"Invalid body: expected { target: user|memory, content, botId? }",
				},
				400,
			);
		}
		if (input.target === "memory" && !input.botId) {
			return c.json({ error: "botId obrigatório para a memória do bot" }, 400);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			if (await botMissing(userId, input.botId)) return c.json({ error: "Bot não encontrado" }, 404);
			const result = await deps.add({ ...input, userId, source: "user", origin: "user" });
			if (!result.ok) {
				return c.json({ ...result, error: memoryErrorMessage(result.error), code: result.error }, actionStatus(result) as 400 | 409);
			}
			return c.json({ entry: result.entry }, 200);
		} catch (error) {
			console.error("add memory entry failed", error);
			return c.json({ error: "Failed to add memory entry" }, 503);
		}
	});

	app.patch("/v1/memory", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const input = parseReplaceInput(json);
		if (!input) {
			return c.json(
				{
					error:
						"Invalid body: expected { target: user|memory, oldText, content, botId? }",
				},
				400,
			);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			if (await botMissing(userId, input.botId)) return c.json({ error: "Bot não encontrado" }, 404);
			const result = await deps.replace({ ...input, userId, source: "user", origin: "user" });
			if (!result.ok) {
				return c.json(result, actionStatus(result) as 400 | 409);
			}
			return c.json({ entry: result.entry }, 200);
		} catch (error) {
			console.error("replace memory entry failed", error);
			return c.json({ error: "Failed to replace memory entry" }, 503);
		}
	});

	app.delete("/v1/memory", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const input = parseRemoveInput(json);
		if (!input) {
			return c.json(
				{
					error:
						"Invalid body: expected { target: user|memory, oldText, botId? }",
				},
				400,
			);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			if (await botMissing(userId, input.botId)) return c.json({ error: "Bot não encontrado" }, 404);
			const result = await deps.remove({ ...input, userId, origin: "user" });
			if (!result.ok) {
				return c.json(result, 400);
			}
			return c.json({ entry: result.entry }, 200);
		} catch (error) {
			console.error("remove memory entry failed", error);
			return c.json({ error: "Failed to remove memory entry" }, 503);
		}
	});

	// --- Aba Memória: edição/remoção por id e histórico ("O que mudou") ---

	app.patch("/v1/memory/entries/:id", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const content = parseContent(json);
		if (!content) return c.json({ error: memoryErrorMessage("conteúdo vazio"), code: "conteúdo vazio" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.editById({ userId, entryId: c.req.param("id"), content, origin: "user" });
			if (!result) return c.json({ error: "Memória não encontrada" }, 404);
			if (!result.ok) return c.json({ ...result, error: memoryErrorMessage(result.error), code: result.error }, actionStatus(result) as 400 | 409);
			return c.json({ entry: result.entry }, 200);
		} catch (error) {
			console.error("edit memory entry failed", error);
			return c.json({ error: "Failed to edit memory entry" }, 503);
		}
	});

	app.delete("/v1/memory/entries/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.removeById({ userId, entryId: c.req.param("id"), origin: "user" });
			if (!result) return c.json({ error: "Memória não encontrada" }, 404);
			if (!result.ok) return c.json({ ...result, error: memoryErrorMessage(result.error), code: result.error }, 400);
			return c.json({ entry: result.entry }, 200);
		} catch (error) {
			console.error("remove memory entry failed", error);
			return c.json({ error: "Failed to remove memory entry" }, 503);
		}
	});

	app.get("/v1/memory/changes", async (c) => {
		const botId = parseBotId(c.req.query("botId"));
		const cursor = parseBotId(c.req.query("cursor"));
		try {
			const { userId } = scopeFor(c.get("session"));
			if (await botMissing(userId, botId)) return c.json({ error: "Bot não encontrado" }, 404);
			const page = await deps.listChanges({ userId, botId, cursor, limit: parseLimit(c.req.query("limit")) });
			return c.json(page);
		} catch (error) {
			console.error("list memory changes failed", error);
			return c.json({ error: "Failed to load memory changes" }, 503);
		}
	});

	app.post("/v1/memory/changes/:id/undo", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.undo({ userId, changeId: c.req.param("id") });
			if (result.ok) return c.json({ change: result.change }, 200);
			if (result.code === "not_found") return c.json({ error: "Mudança não encontrada", code: result.code, message: result.message }, 404);
			return c.json({ error: result.message, code: result.code, message: result.message }, 409);
		} catch (error) {
			console.error("undo memory change failed", error);
			return c.json({ error: "Failed to undo memory change" }, 503);
		}
	});

	// --- Limpeza com aprovação: o worker só sugere; nada muda até o usuário aplicar ---

	const cleanup = deps.cleanup ?? defaultCleanup;

	/** Bot do corpo/consulta, já conferido como do usuário; senão a resposta de erro pronta. */
	async function cleanupBot(c: import("hono").Context<AuthEnv>, botId: string | undefined): Promise<{ userId: string; botId: string } | Response> {
		if (!botId) return c.json({ error: "botId obrigatório" }, 400);
		const { userId } = scopeFor(c.get("session"));
		if (await botMissing(userId, botId)) return c.json({ error: "Bot não encontrado" }, 404);
		return { userId, botId };
	}
	const bodyBotId = async (c: import("hono").Context<AuthEnv>): Promise<string | undefined> => {
		try {
			return parseBotId(((await c.req.json()) as { botId?: unknown } | null)?.botId);
		} catch {
			return undefined;
		}
	};
	const without = (list: MemoryCleanupSuggestion[], id: string) => list.filter((item) => item.id !== id);

	app.get("/v1/memory/cleanup", async (c) => {
		try {
			const scoped = await cleanupBot(c, parseBotId(c.req.query("botId")));
			if (scoped instanceof Response) return scoped;
			const view = await cleanup.get(scoped.userId, scoped.botId);
			if (!view) return c.json({ error: "Bot não encontrado" }, 404);
			return c.json({ cleanup: view });
		} catch (error) {
			console.error("load memory cleanup failed", error);
			return c.json({ error: "Não foi possível ler as sugestões" }, 503);
		}
	});

	/** Pede a revisão em segundo plano. Já revisando (e não velho) = não enfileira de novo. */
	app.post("/v1/memory/cleanup", async (c) => {
		try {
			const scoped = await cleanupBot(c, await bodyBotId(c));
			if (scoped instanceof Response) return scoped;
			const current = await cleanup.get(scoped.userId, scoped.botId);
			if (!current) return c.json({ error: "Bot não encontrado" }, 404);
			if (current.status === "generating") return c.json({ queued: false, cleanup: current }, 202);
			if (!(await cleanup.enqueue({ userId: scoped.userId, botId: scoped.botId }))) return c.json({ error: "Não foi possível iniciar a revisão agora" }, 503);
			return c.json({ queued: true }, 202);
		} catch (error) {
			console.error("start memory cleanup failed", error);
			return c.json({ error: "Não foi possível iniciar a revisão" }, 503);
		}
	});

	app.post("/v1/memory/cleanup/apply-all", async (c) => {
		try {
			const scoped = await cleanupBot(c, await bodyBotId(c));
			if (scoped instanceof Response) return scoped;
			const current = await cleanup.get(scoped.userId, scoped.botId);
			if (!current) return c.json({ error: "Bot não encontrado" }, 404);
			let applied = 0;
			let skipped = 0;
			for (const suggestion of current.suggestions) {
				if (await applySuggestion(cleanup, scoped.userId, scoped.botId, suggestion)) applied += 1;
				else skipped += 1;
			}
			const view = await cleanup.save(scoped.userId, scoped.botId, []);
			return c.json({ cleanup: view, applied, skipped });
		} catch (error) {
			console.error("apply all memory cleanup failed", error);
			return c.json({ error: "Não foi possível aplicar as sugestões" }, 503);
		}
	});

	app.post("/v1/memory/cleanup/:sid/apply", async (c) => {
		try {
			const scoped = await cleanupBot(c, await bodyBotId(c));
			if (scoped instanceof Response) return scoped;
			const current = await cleanup.get(scoped.userId, scoped.botId);
			const picked = current?.suggestions.find((item) => item.id === c.req.param("sid"));
			if (!current || !picked) return c.json({ error: "Sugestão não encontrada" }, 404);
			const done = await applySuggestion(cleanup, scoped.userId, scoped.botId, picked);
			const view = await cleanup.save(scoped.userId, scoped.botId, without(current.suggestions, picked.id));
			if (!done) return c.json({ error: "Essa sugestão não vale mais: as memórias mudaram.", code: "stale", cleanup: view }, 409);
			return c.json({ cleanup: view });
		} catch (error) {
			console.error("apply memory cleanup failed", error);
			return c.json({ error: "Não foi possível aplicar a sugestão" }, 503);
		}
	});

	app.post("/v1/memory/cleanup/:sid/dismiss", async (c) => {
		try {
			const scoped = await cleanupBot(c, await bodyBotId(c));
			if (scoped instanceof Response) return scoped;
			const current = await cleanup.get(scoped.userId, scoped.botId);
			if (!current?.suggestions.some((item) => item.id === c.req.param("sid"))) return c.json({ error: "Sugestão não encontrada" }, 404);
			const view = await cleanup.save(scoped.userId, scoped.botId, without(current.suggestions, c.req.param("sid")));
			return c.json({ cleanup: view });
		} catch (error) {
			console.error("dismiss memory cleanup failed", error);
			return c.json({ error: "Não foi possível ignorar a sugestão" }, 503);
		}
	});

	return app;
}
