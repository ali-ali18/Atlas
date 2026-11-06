// Porta `Memory` do v4 no worker (F2.6) sobre as entradas de memória do db. Duas camadas, como no produto:
//  - `owner` = alvo `user` (perfil e preferências; vale para todos os bots do dono);
//  - `bot`   = alvo `memory` (o que é DESTE bot). O bot vem preso na montagem (um adaptador por run), nunca do modelo.
// Escopo: toda função do db recebe o `userId` do run. Trocar ou apagar por id confere antes que a entrada é do dono e, na
// camada do bot, que é deste bot; entrada de outro dono ou de outro bot dá `null`/`false`, igual a inexistente.
import type { Memory, MemoryAddInput, MemoryItem, MemoryLayer } from "@workspace/agent";
import { addMemoryEntry, getMemoryEntryById, getMemorySnapshot, removeMemoryEntryById, replaceMemoryEntryById } from "@workspace/db";
import type { MemoryActionResult, MemoryEntry, MemoryTarget } from "@workspace/shared";

export type V4MemoryDeps = {
	snapshot: typeof getMemorySnapshot;
	add: typeof addMemoryEntry;
	getById: (userId: string, entryId: string) => Promise<{ id: string; userId: string; botId: string | null; target: string } | null>;
	replaceById: typeof replaceMemoryEntryById;
	removeById: typeof removeMemoryEntryById;
};

export const realV4MemoryDeps: V4MemoryDeps = {
	snapshot: getMemorySnapshot,
	add: addMemoryEntry,
	getById: getMemoryEntryById,
	replaceById: replaceMemoryEntryById,
	removeById: removeMemoryEntryById,
};

const TARGET_OF: Readonly<Record<MemoryLayer, MemoryTarget>> = { owner: "user", bot: "memory" };
const LAYER_OF: Readonly<Record<string, MemoryLayer>> = { user: "owner", memory: "bot" };

function toItem(entry: MemoryEntry, layer: MemoryLayer): MemoryItem {
	return { id: entry.id, layer, content: entry.content, ...(entry.category && { category: entry.category }), updatedAt: new Date(entry.updatedAt) };
}

/** Falha do db vira erro com o motivo real (a tool devolve `ok:false`); o texto do db é nosso, sem segredo. */
function unwrap(result: MemoryActionResult, what: string): MemoryEntry | undefined {
	if (!result.ok) throw new Error(`Could not ${what}: ${result.error} (${result.usage}).`);
	return result.entry;
}

export function createV4Memory(input: { botId?: string | null; deps?: V4MemoryDeps }): Memory {
	const deps = input.deps ?? realV4MemoryDeps;
	const botId = input.botId?.trim() || undefined;

	/** A entrada existe, é do dono e está numa camada que este run alcança. */
	const reachable = async (userId: string, id: string): Promise<boolean> => {
		const row = await deps.getById(userId, id);
		// Legado `default` é de quem for "default"; para qualquer outro usuário a linha não existe (o db a devolve por compatibilidade).
		if (!row || row.userId !== userId) return false;
		if (row.target === "user") return true;
		return row.target === "memory" && botId !== undefined && row.botId === botId;
	};

	return {
		async list(userId, layer) {
			const snapshot = await deps.snapshot(userId, botId);
			// O snapshot do db inclui linhas legadas `default`; aqui só entra o que é do dono do run (entrada sem dono confirmado sai).
			const own = async (entries: MemoryEntry[]): Promise<MemoryEntry[]> => {
				const rows = await Promise.all(entries.map((entry) => deps.getById(userId, entry.id)));
				return entries.filter((_, index) => rows[index]?.userId === userId);
			};
			const items: MemoryItem[] = [];
			if (layer !== "bot") items.push(...(await own(snapshot.user.entries)).map((entry) => toItem(entry, "owner")));
			if (layer !== "owner" && botId) items.push(...(await own(snapshot.memory.entries)).map((entry) => toItem(entry, "bot")));
			return items.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
		},
		async add(userId, add: MemoryAddInput) {
			if (add.layer === "bot" && !botId) throw new Error("This run has no bot, so there is no bot memory. Use the owner layer or tell the owner plainly.");
			const entry = unwrap(await deps.add({ userId, ...(botId && { botId }), target: TARGET_OF[add.layer], content: add.content, ...(add.category && { category: add.category }), source: "agent", origin: "chat" }), "save the memory");
			if (!entry) throw new Error("Could not save the memory.");
			return toItem(entry, add.layer);
		},
		async replace(userId, id, content) {
			if (!(await reachable(userId, id))) return null;
			const result = await deps.replaceById({ userId, entryId: id, content, origin: "chat" });
			if (!result) return null;
			const entry = unwrap(result, "change the memory");
			return entry ? toItem(entry, LAYER_OF[entry.target] ?? "owner") : null;
		},
		async remove(userId, id) {
			if (!(await reachable(userId, id))) return false;
			const result = await deps.removeById({ userId, entryId: id, origin: "chat" });
			if (!result) return false;
			unwrap(result, "remove the memory");
			return true;
		},
	};
}
