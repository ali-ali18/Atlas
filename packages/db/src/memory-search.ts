import { Prisma } from "@prisma/client";
import { embedText } from "@workspace/llm";
import type { MemoryEntry, MemoryTarget } from "@workspace/shared";
import { prisma } from "./client.js";
import { getMemorySnapshot, memoryRef, promptMemoryView, renderMemoryStoreBlock, toMemoryEntry } from "./memory-entries.js";

export type MemorySearchHit = {
	entry: MemoryEntry;
	/** Fusão de ranks (RRF); maior = mais relevante. */
	score: number;
	via: "vector" | "text" | "both";
};

export type MemorySearchInput = {
	userId?: string;
	botId?: string;
	query: string;
	/** Candidatos por ramo antes da fusão. */
	perBranch?: number;
	/** Fatos retornados após fusão. */
	limit?: number;
	/** Teto de caracteres somados (corta por fato inteiro, nunca no meio). */
	maxChars?: number;
};

const RRF_K = 60;

function botFilter(botId: string | null) {
	return botId === null
		? Prisma.sql`"botId" IS NULL`
		: Prisma.sql`"botId" = ${botId}`;
}

function userFilter(userId: string) {
	return userId === "default"
		? Prisma.sql`"userId" = ${userId}`
		: Prisma.sql`"userId" IN (${userId}, 'default')`;
}

async function vectorBranch(input: {
	userId: string;
	botId: string | null;
	target: MemoryTarget;
	embedding: number[];
	perBranch: number;
}): Promise<string[]> {
	const literal = `[${input.embedding.join(",")}]`;
	const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id
		FROM memory_entries
		WHERE ${userFilter(input.userId)} AND target = ${input.target} AND ${botFilter(input.botId)}
			AND embedding IS NOT NULL
			AND ("validUntil" IS NULL OR "validUntil" > NOW())
		ORDER BY embedding <=> ${literal}::vector
		LIMIT ${input.perBranch}`;
	return rows.map((row) => row.id);
}

async function textBranch(input: {
	userId: string;
	botId: string | null;
	target: MemoryTarget;
	query: string;
	perBranch: number;
}): Promise<string[]> {
	const like = `%${input.query.slice(0, 120)}%`;
	const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id
		FROM memory_entries
		WHERE ${userFilter(input.userId)} AND target = ${input.target} AND ${botFilter(input.botId)}
			AND ("validUntil" IS NULL OR "validUntil" > NOW())
			AND (to_tsvector('portuguese', content) @@ plainto_tsquery('portuguese', ${input.query})
				OR content ILIKE ${like})
		ORDER BY ts_rank(to_tsvector('portuguese', content), plainto_tsquery('portuguese', ${input.query})) DESC
		LIMIT ${input.perBranch}`;
	return rows.map((row) => row.id);
}

async function tryEmbedQuery(query: string): Promise<number[] | null> {
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	if (!apiKey) return null;
	try {
		const result = await embedText({ text: query, apiKey });
		if (!result.embedding.every(Number.isFinite)) return null;
		return result.embedding;
	} catch (error) {
		console.warn(
			"memory search embedding failed; text-only",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

/** Busca híbrida (vetor + texto, fusão RRF) com escopo e validade. */
export async function searchMemoryEntries(
	input: MemorySearchInput,
): Promise<MemorySearchHit[]> {
	const userId = input.userId ?? "default";
	const query = input.query.trim();
	const perBranch = input.perBranch ?? 12;
	const limit = input.limit ?? 8;
	const maxChars = input.maxChars ?? 2500;
	if (!query) return [];

	const botId = input.botId?.trim() ? input.botId.trim() : undefined;
	const embedding = await tryEmbedQuery(query);
	const scores = new Map<string, { score: number; via: Set<string> }>();
	const bump = (id: string, rank: number, via: string) => {
		const current = scores.get(id) ?? { score: 0, via: new Set<string>() };
		current.score += 1 / (RRF_K + rank);
		current.via.add(via);
		scores.set(id, current);
	};

	for (const target of ["user", "memory"] as const) {
		const scopeBotId = target === "user" ? null : (botId ?? null);
		if (embedding) {
			const ids = await vectorBranch({
				userId,
				botId: scopeBotId,
				target,
				embedding,
				perBranch,
			});
			ids.forEach((id, index) => bump(id, index + 1, "vector"));
		}
		const ids = await textBranch({
			userId,
			botId: scopeBotId,
			target,
			query,
			perBranch,
		});
		ids.forEach((id, index) => bump(id, index + 1, "text"));
	}

	if (scores.size === 0) return [];
	const ranked = [...scores.entries()]
		.sort((a, b) => b[1].score - a[1].score)
		.slice(0, limit);

	const rows = await prisma.memoryEntry.findMany({
		where: { id: { in: ranked.map(([id]) => id) } },
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	const hits: MemorySearchHit[] = [];
	let chars = 0;
	for (const [id, meta] of ranked) {
		const row = byId.get(id);
		if (!row) continue;
		if (chars > 0 && chars + row.content.length > maxChars) continue;
		chars += row.content.length;
		hits.push({
			entry: toMemoryEntry(row),
			score: meta.score,
			via: (meta.via.has("vector") && meta.via.has("text")
				? "both"
				: meta.via.has("vector")
					? "vector"
					: "text") as MemorySearchHit["via"],
		});
	}
	return hits;
}

function renderRelevantBlock(
	label: string,
	hits: MemorySearchHit[],
	target: MemoryTarget,
): string | null {
	const mine = hits.filter((hit) => hit.entry.target === target);
	if (mine.length === 0) return null;
	const header = `════ ${label} (por relevância) ════`;
	const body = mine
		.map((hit) => {
			const tag = hit.entry.category ? ` [${hit.entry.category}]` : "";
			return `- [${memoryRef(hit.entry.id)}] ${hit.entry.content}${tag}`;
		})
		.join("\n");
	return `${header}\n${body}`;
}

/**
 * F2 — memória em dois tiers. `stable`: perfil USER integral (e as notas do bot
 * inteiras quando não há pergunta para ranquear): muda só quando a memória muda.
 * `volatile`: notas do bot por relevância à pergunta: muda a cada pedido, então
 * quem monta o prompt a coloca depois do histórico, nunca no prefixo.
 * Conta única: leitura inclui o legado `default`.
 */
export async function renderMemoryTiers(
	userId?: string,
	botId?: string,
	query?: string,
): Promise<{ stable: string | null; volatile: string | null }> {
	const effective = userId ?? "default";
	const snapshot = await getMemorySnapshot(effective, botId);
	const userBlock = renderMemoryStoreBlock(
		"USER (perfil do usuário)",
		snapshot.user,
	);
	const trimmed = query?.trim() ?? "";
	if (!trimmed) {
		const memoryBlock = renderMemoryStoreBlock("MEMORY (notas do agente)", promptMemoryView(snapshot.memory));
		const blocks = [userBlock, memoryBlock].filter((block): block is string => Boolean(block));
		return { stable: blocks.length > 0 ? blocks.join("\n\n") : null, volatile: null };
	}
	const hits = await searchMemoryEntries({ userId: effective, botId, query: trimmed });
	return { stable: userBlock, volatile: renderRelevantBlock("MEMORY (notas do agente)", hits, "memory") };
}

/** Perfil USER sempre integral; notas do bot só por relevância da pergunta (tudo num bloco só). */
export async function renderRelevantMemoryPrompt(
	userId?: string,
	botId?: string,
	query?: string,
): Promise<string | null> {
	const tiers = await renderMemoryTiers(userId, botId, query);
	const blocks = [tiers.stable, tiers.volatile].filter((block): block is string => Boolean(block));
	return blocks.length > 0 ? blocks.join("\n\n") : null;
}
