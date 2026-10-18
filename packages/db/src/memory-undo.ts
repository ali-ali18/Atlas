import type { MemoryChange, MemoryTarget } from "@workspace/shared";
import { prisma } from "./client.js";
import { loadStore, refreshMemoryEmbedding } from "./memory-entries.js";
import { memoryMetaOf, parseMemoryMeta, recordMemoryChange, toMemoryChange } from "./memory-changes.js";

export type MemoryUndoCode = "not_found" | "already_undone" | "not_undoable" | "stale" | "duplicate" | "limit";

export type MemoryUndoResult =
	| { ok: true; change: MemoryChange }
	| { ok: false; code: MemoryUndoCode; message: string };

const MESSAGES: Record<MemoryUndoCode, string> = {
	not_found: "Mudança não encontrada.",
	already_undone: "Essa mudança já foi desfeita.",
	not_undoable: "Um desfazer não pode ser desfeito de novo.",
	stale: "Não deu para desfazer: essa memória foi alterada depois. Edite ou apague direto na lista.",
	duplicate: "Não deu para desfazer: já existe uma memória com esse mesmo texto.",
	limit: "Não deu para desfazer: não há espaço na memória. Apague algo e tente de novo.",
};

/** Recusa dentro da transação: lançar faz o rollback (inclusive da marca `undoneAt`). */
class UndoRefusal extends Error {
	constructor(readonly code: MemoryUndoCode) {
		super(MESSAGES[code]);
	}
}

/**
 * Desfaz uma mudança do histórico. add → apaga a entrada; replace → devolve o texto anterior;
 * remove → recria a entrada (mesmo id, se livre). Se a entrada mudou depois (texto diferente do que
 * a mudança deixou), RECUSA em vez de sobrescrever. O desfazer também entra no histórico (origem
 * "user", `undoOfId`) e a mudança original ganha `undoneAt`. Tudo numa transação.
 */
export async function undoMemoryChange(input: { userId: string; changeId: string; now?: Date }): Promise<MemoryUndoResult> {
	const { userId } = input;
	const now = input.now ?? new Date();
	const change = await prisma.memoryChange.findFirst({ where: { id: input.changeId, userId } });
	if (!change) return refuse("not_found");
	if (change.undoneAt) return refuse("already_undone");
	if (change.undoOfId) return refuse("not_undoable");

	const target = change.target as MemoryTarget;
	const botId = target === "user" ? null : change.botId;
	let restored: { entryId: string; content: string } | null = null;
	try {
		const created = await prisma.$transaction(async (tx) => {
			const claimed = await tx.memoryChange.updateMany({ where: { id: change.id, userId, undoneAt: null }, data: { undoneAt: now } });
			if (claimed.count === 0) throw new UndoRefusal("already_undone");

			if (change.action === "add") {
				const entry = change.entryId ? await tx.memoryEntry.findFirst({ where: { id: change.entryId, userId } }) : null;
				if (!entry || entry.content !== change.after) throw new UndoRefusal("stale");
				await tx.memoryEntry.delete({ where: { id: entry.id } });
				return recordMemoryChange(tx, { userId, botId: change.botId, entryId: entry.id, target, action: "remove", before: entry.content, beforeMeta: memoryMetaOf(entry), source: "user", undoOfId: change.id });
			}

			if (change.action === "replace") {
				const entry = change.entryId ? await tx.memoryEntry.findFirst({ where: { id: change.entryId, userId } }) : null;
				if (!entry || entry.content !== change.after || change.before === null) throw new UndoRefusal("stale");
				const meta = parseMemoryMeta(change.beforeMeta);
				await tx.memoryEntry.update({
					where: { id: entry.id },
					data: {
						content: change.before,
						...(meta ? { category: meta.category, confidence: meta.confidence, importance: meta.importance ?? 0, source: meta.source, validUntil: meta.validUntil ? new Date(meta.validUntil) : null } : {}),
					},
				});
				restored = { entryId: entry.id, content: change.before };
				return recordMemoryChange(tx, { userId, botId: change.botId, entryId: entry.id, target, action: "replace", before: entry.content, after: change.before, beforeMeta: memoryMetaOf(entry), source: "user", undoOfId: change.id });
			}

			// remove → recria
			if (change.before === null) throw new UndoRefusal("stale");
			const store = await loadStore(userId, botId ?? undefined, target);
			if (store.rows.some((row) => row.content === change.before)) throw new UndoRefusal("duplicate");
			if (store.used + change.before.length > store.limit) throw new UndoRefusal("limit");
			const sameId = change.entryId ? await tx.memoryEntry.findFirst({ where: { id: change.entryId }, select: { id: true } }) : null;
			const meta = parseMemoryMeta(change.beforeMeta);
			const entry = await tx.memoryEntry.create({
				data: {
					...(change.entryId && !sameId ? { id: change.entryId } : {}),
					userId,
					botId,
					target,
					content: change.before,
					category: meta?.category ?? undefined,
					confidence: meta?.confidence ?? undefined,
					importance: meta?.importance ?? 0,
					source: meta?.source ?? undefined,
					validUntil: meta?.validUntil ? new Date(meta.validUntil) : undefined,
				},
			});
			restored = { entryId: entry.id, content: change.before };
			return recordMemoryChange(tx, { userId, botId: change.botId, entryId: entry.id, target, action: "add", after: change.before, source: "user", undoOfId: change.id });
		});
		if (restored) {
			const { entryId, content } = restored as { entryId: string; content: string };
			await refreshMemoryEmbedding(entryId, content).catch((error) => console.warn("memory embedding refresh failed", error));
		}
		const row = await prisma.memoryChange.findFirst({ where: { id: created.id, userId } });
		return row ? { ok: true, change: toMemoryChange(row) } : refuse("not_found");
	} catch (error) {
		if (error instanceof UndoRefusal) return refuse(error.code);
		throw error;
	}
}

function refuse(code: MemoryUndoCode): MemoryUndoResult {
	return { ok: false, code, message: MESSAGES[code] };
}
