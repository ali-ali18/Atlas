import type {
	MemoryActionResult,
	MemoryChangeSource,
	MemoryEntry,
	MemorySnapshot,
	MemoryStoreView,
	MemoryTarget,
	MemoryUsage,
} from "@workspace/shared";
import { Prisma } from "@prisma/client";
import { embedText } from "@workspace/llm";
import { prisma } from "./client.js";
import { getAccountConfig } from "./settings.js";
import { resolveOrchestratorMemoryChars } from "@workspace/shared";
import { changeSourceFor } from "@workspace/shared";
import { memoryMetaOf, recordMemoryChange } from "./memory-changes.js";

export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

/** Distância cosseno máxima para considerar paráfrase de fato existente.
 * Conservador de propósito: só barra quase-duplicatas. */
export const SEMANTIC_DUP_MAX_DISTANCE = 0.08;

const STORE_ORDER = { createdAt: "asc" } as const;

const UNSAFE_PATTERNS: readonly RegExp[] = [
	/ignore (all )?previous instructions/i,
	/-----BEGIN/,
	/BEGIN RSA PRIVATE KEY/,
];

type MemoryRow = {
	id: string;
	botId?: string | null;
	target: string;
	content: string;
	category?: string | null;
	confidence?: number | null;
	importance?: number | null;
	source?: string | null;
	validUntil?: Date | null;
	access?: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type MemoryMetadataInput = {
	category?: string;
	confidence?: number;
	importance?: number;
	source?: string;
	validUntil?: string;
	/** Quem fez a mudança no histórico; sem isso deduz do `source` (ver `changeSourceFor`). */
	origin?: MemoryChangeSource;
};

function toValidDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

export function toMemoryEntry(row: MemoryRow): MemoryEntry {
	return {
		id: row.id,
		target: row.target as MemoryTarget,
		content: row.content,
		category: row.category ?? null,
		confidence: row.confidence ?? null,
		importance: row.importance ?? null,
		source: row.source ?? null,
		validUntil: row.validUntil ? row.validUntil.toISOString() : null,
		access: row.access ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function embeddingApiKey(): string | null {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

/** Gera embedding ou null (sem key/falha = salva sem vetor, sem quebrar). */
async function tryEmbed(content: string): Promise<number[] | null> {
	const apiKey = embeddingApiKey();
	if (!apiKey) return null;
	try {
		const result = await embedText({ text: content, apiKey });
		if (!result.embedding.every(Number.isFinite)) return null;
		return result.embedding;
	} catch (error) {
		console.warn(
			"memory embedding failed; saving entry without vector",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

function vectorLiteral(vector: number[]): string {
	return `[${vector.join(",")}]`;
}

async function storeEmbedding(id: string, vector: number[]): Promise<void> {
	await prisma.$executeRaw`UPDATE memory_entries SET embedding = ${vectorLiteral(vector)}::vector WHERE id = ${id}`;
}

type NearHit = { id: string; content: string; distance: number };

async function findNearDuplicate(input: {
	userId: string;
	botId: string | null;
	target: MemoryTarget;
	embedding: number[];
	excludeId?: string;
	limit?: number;
}): Promise<NearHit[]> {
	const literal = vectorLiteral(input.embedding);
	const botFilter =
		input.botId === null
			? Prisma.sql`"botId" IS NULL`
			: Prisma.sql`"botId" = ${input.botId}`;
	const excludeFilter = input.excludeId
		? Prisma.sql`AND id <> ${input.excludeId}`
		: Prisma.empty;
	const userFilter =
		input.userId === "default"
			? Prisma.sql`"userId" = ${input.userId}`
			: Prisma.sql`"userId" IN (${input.userId}, 'default')`;
	return prisma.$queryRaw<NearHit[]>`SELECT id, content, embedding <=> ${literal}::vector AS distance
		FROM memory_entries
		WHERE ${userFilter} AND target = ${input.target} AND ${botFilter} AND embedding IS NOT NULL
		${excludeFilter}
		ORDER BY embedding <=> ${literal}::vector
		LIMIT ${input.limit ?? 3}`;
}

function limitFor(target: MemoryTarget): number {
	return target === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

/**
 * Limite da camada `memory` DESTE bot: o bot principal (orquestrador) usa o limite próprio da conta
 * (`reflection.memoryChars`, padrão maior); os demais bots e o perfil `user` seguem o limite fixo.
 */
export async function memoryLimitFor(userId: string, botId: string | undefined, target: MemoryTarget): Promise<number> {
	if (target === "user" || !botId?.trim()) return limitFor(target);
	try {
		const primary = await prisma.bot.findFirst({ where: { id: botId.trim(), ownerId: userId, isPrimary: true }, select: { id: true } });
		if (!primary) return limitFor(target);
		return resolveOrchestratorMemoryChars(await getAccountConfig(userId));
	} catch {
		return limitFor(target);
	}
}

function resolveBotId(
	target: MemoryTarget,
	botId: string | undefined,
): string | null {
	if (target === "user") {
		return null;
	}
	const trimmed = botId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function storeWhere(
	userId: string,
	target: MemoryTarget,
	botId: string | undefined,
) {
	return {
		userId,
		target,
		botId: resolveBotId(target, botId),
	};
}

/**
 * Conta única, sem filtrar legado: leitura lista tudo por enquanto —
 * inclui a linha legada `userId="default"` junto com a do usuário.
 * Escrita continua gravando só o `userId` da sessão.
 */
function readUserIds(userId: string): string[] {
	return userId === "default" ? ["default"] : [userId, "default"];
}

function storeWhereForRead(
	userId: string,
	target: MemoryTarget,
	botId: string | undefined,
) {
	return {
		userId: { in: readUserIds(userId) },
		target,
		botId: resolveBotId(target, botId),
	};
}

function usageFor(used: number, target: MemoryTarget, limit: number = limitFor(target)): MemoryUsage {
	return { used, limit };
}

function formatUsage(usage: MemoryUsage): string {
	return `${usage.used}/${usage.limit} chars`;
}

function detectUnsafe(content: string): string | null {
	for (const pattern of UNSAFE_PATTERNS) {
		if (pattern.test(content)) {
			return "conteúdo bloqueado pela verificação de segurança";
		}
	}
	return null;
}

function viewFromRows(rows: MemoryRow[], target: MemoryTarget, limit?: number): MemoryStoreView {
	const used = rows.reduce((sum, row) => sum + row.content.length, 0);
	return {
		entries: rows.map(toMemoryEntry),
		usage: usageFor(used, target, limit),
	};
}

export async function loadStore(
	userId: string,
	botId: string | undefined,
	target: MemoryTarget,
): Promise<{ rows: MemoryRow[]; used: number; limit: number }> {
	const rows = await prisma.memoryEntry.findMany({
		where: storeWhereForRead(userId, target, botId),
		orderBy: STORE_ORDER,
	});
	const used = rows.reduce((sum, row) => sum + row.content.length, 0);
	return { rows, used, limit: await memoryLimitFor(userId, botId, target) };
}

/** Referência curta e estável de uma entrada para o agente (final do id: o início do cuid é quase igual entre linhas). */
export const MEMORY_REF_LENGTH = 4;
export function memoryRef(id: string): string {
	return id.slice(-MEMORY_REF_LENGTH);
}

/** Entradas da camada que batem com a ref (aceita `[x7k2]`, sem diferenciar maiúsculas; id completo também vale). */
function rowsByRef(rows: MemoryRow[], ref: string): MemoryRow[] {
	const clean = ref.trim().replace(/^\[|\]$/g, "").trim().toLowerCase();
	if (clean.length < MEMORY_REF_LENGTH) return [];
	return rows.filter((row) => row.id.toLowerCase().endsWith(clean));
}

/** Remove ref(s) `[xxxx]` (ou id completo) coladas no início do conteúdo, com marcador de lista/§ antes; colchetes no meio do texto ficam. */
const LEADING_REF = /^(?:[\s§*•-]*\[(?=[a-z0-9]*[a-z])(?:[a-z0-9]{4}|c[a-z0-9]{20,30})\])+[\s§*•-]*/i;
export function stripMemoryRefPrefix(content: string): string {
	return content.replace(LEADING_REF, "").trim();
}

function refLine(row: MemoryRow): string {
	return `[${memoryRef(row.id)}] ${row.content}`;
}

function failure(
	error: string,
	store: { rows: MemoryRow[]; used: number; limit: number },
	target: MemoryTarget,
	candidates?: MemoryRow[],
): MemoryActionResult {
	return {
		ok: false,
		error,
		currentEntries: (candidates ?? store.rows).map(refLine),
		usage: formatUsage(usageFor(store.used, target, store.limit)),
	};
}

export async function getMemorySnapshot(
	userId?: string,
	botId?: string,
): Promise<MemorySnapshot> {
	const effective = userId ?? "default";
	const memoryLimit = await memoryLimitFor(effective, botId, "memory");
	const [userRows, memoryRows] = await Promise.all([
		prisma.memoryEntry.findMany({
			where: storeWhereForRead(effective, "user", botId),
			orderBy: STORE_ORDER,
		}),
		prisma.memoryEntry.findMany({
			where: storeWhereForRead(effective, "memory", botId),
			orderBy: STORE_ORDER,
		}),
	]);

	return {
		user: viewFromRows(userRows, "user"),
		memory: viewFromRows(memoryRows, "memory", memoryLimit),
	};
}

function renderBlock(label: string, view: MemoryStoreView): string {
	const { used, limit } = view.usage;
	const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
	const header = `════ ${label} [${percent}% — ${used}/${limit} chars] ════`;
	const body = view.entries.map((entry) => `[${memoryRef(entry.id)}]${entry.content}`).join("§");
	return `${header}\n${body}`;
}

export function renderMemoryStoreBlock(
	label: string,
	view: MemoryStoreView,
): string | null {
	if (view.entries.length === 0) return null;
	return renderBlock(label, view);
}

export async function renderMemoryPrompt(
	userId?: string,
	botId?: string,
): Promise<string | null> {
	const effective = userId ?? "default";
	const snapshot = await getMemorySnapshot(effective, botId);
	const blocks: string[] = [];

	if (snapshot.memory.entries.length > 0) {
		blocks.push(renderBlock("MEMORY (notas do agente)", snapshot.memory));
	}
	if (snapshot.user.entries.length > 0) {
		blocks.push(renderBlock("USER (perfil do usuário)", snapshot.user));
	}

	if (blocks.length === 0) {
		return null;
	}

	return blocks.join("\n\n");
}

export async function addMemoryEntry(input: {
	userId?: string;
	botId?: string;
	target: MemoryTarget;
	content: string;
} & MemoryMetadataInput): Promise<MemoryActionResult> {
	const userId = input.userId ?? "default";
	const content = stripMemoryRefPrefix(input.content);
	const botId = resolveBotId(input.target, input.botId);
	const store = await loadStore(userId, input.botId, input.target);

	if (content.length === 0) {
		return failure("conteúdo vazio", store, input.target);
	}

	const unsafe = detectUnsafe(content);
	if (unsafe) {
		return failure(unsafe, store, input.target);
	}

	if (store.rows.some((row) => row.content === content)) {
		return failure("duplicado", store, input.target);
	}

	if (store.used + content.length > store.limit) {
		return failure(
			`limite de ${store.limit} caracteres excedido`,
			store,
			input.target,
		);
	}

	const embedding = await tryEmbed(content);
	if (embedding) {
		const near = await findNearDuplicate({
			userId,
			botId,
			target: input.target,
			embedding,
			limit: 1,
		});
		if (near[0] && near[0].distance < SEMANTIC_DUP_MAX_DISTANCE) {
			return failure("duplicado", store, input.target);
		}
	}

	const row = await prisma.$transaction(async (tx) => {
		const created = await tx.memoryEntry.create({
			data: {
				userId,
				botId,
				target: input.target,
				content,
				category: input.category?.trim() || undefined,
				confidence: input.confidence,
				importance: input.importance ?? 0,
				source: input.source?.trim() || undefined,
				validUntil: toValidDate(input.validUntil),
			},
		});
		await recordMemoryChange(tx, {
			userId,
			botId: input.botId,
			entryId: created.id,
			target: input.target,
			action: "add",
			after: content,
			source: changeSourceFor(input.source, input.origin),
		});
		return created;
	});
	if (embedding) {
		await storeEmbedding(row.id, embedding).catch((error) =>
			console.warn("memory embedding store failed", error),
		);
	}

	return { ok: true, entry: toMemoryEntry(row) };
}

/** Localiza UMA entrada por ref (preferido) ou por trecho; senão devolve a falha com os candidatos (e suas refs). */
function locateRow(
	store: { rows: MemoryRow[]; used: number; limit: number },
	target: MemoryTarget,
	input: { ref?: string; oldText?: string },
): { row: MemoryRow } | { fail: MemoryActionResult } {
	const ref = input.ref?.trim();
	if (ref) {
		const byRef = rowsByRef(store.rows, ref);
		if (byRef.length === 1 && byRef[0]) return { row: byRef[0] };
		if (byRef.length > 1) return { fail: failure("ref ambígua (mais de uma entrada)", store, target, byRef) };
		return { fail: failure("nenhuma entrada com essa ref nesta camada", store, target) };
	}
	const oldText = input.oldText?.trim() ?? "";
	if (oldText.length === 0) return { fail: failure("informe ref ou oldText", store, target) };
	const matches = store.rows.filter((row) => row.content.includes(oldText));
	if (matches.length === 0) return { fail: failure("nenhuma entrada corresponde a oldText", store, target) };
	if (matches.length > 1 || !matches[0]) {
		return { fail: failure("oldText ambíguo (mais de uma entrada): repita com a ref da entrada certa", store, target, matches) };
	}
	return { row: matches[0] };
}

export async function replaceMemoryEntry(input: {
	userId?: string;
	botId?: string;
	target: MemoryTarget;
	oldText?: string;
	ref?: string;
	content: string;
} & MemoryMetadataInput): Promise<MemoryActionResult> {
	const userId = input.userId ?? "default";
	const content = stripMemoryRefPrefix(input.content);
	const store = await loadStore(userId, input.botId, input.target);
	const found = locateRow(store, input.target, input);
	if ("fail" in found) return found.fail;
	return applyReplace({ userId, store, row: found.row, content, input });
}

/**
 * Funde 2+ entradas da MESMA camada numa só (dedupe): a primeira recebe o texto novo e as demais são apagadas,
 * tudo numa transação, cada passo no histórico (desfazível). A camada vem do store do dono, então ref de outro
 * usuário/bot simplesmente não é encontrada.
 */
export async function mergeMemoryEntries(input: {
	userId?: string;
	botId?: string;
	target: MemoryTarget;
	refs: string[];
	content: string;
} & MemoryMetadataInput): Promise<MemoryActionResult> {
	const userId = input.userId ?? "default";
	const content = stripMemoryRefPrefix(input.content);
	const store = await loadStore(userId, input.botId, input.target);
	const picked = new Map<string, MemoryRow>();
	for (const ref of input.refs) {
		const hit = rowsByRef(store.rows, ref);
		if (hit.length !== 1 || !hit[0]) return failure(`ref "${ref}" não encontrada (ou ambígua) nesta camada`, store, input.target, hit.length > 1 ? hit : undefined);
		picked.set(hit[0].id, hit[0]);
	}
	const rows = [...picked.values()];
	if (rows.length < 2) return failure("merge precisa de 2 ou mais entradas distintas", store, input.target);
	if (content.length === 0) return failure("conteúdo vazio", store, input.target);
	const unsafe = detectUnsafe(content);
	if (unsafe) return failure(unsafe, store, input.target);
	const nextUsed = store.used - rows.reduce((sum, row) => sum + row.content.length, 0) + content.length;
	if (nextUsed > store.limit) return failure(`limite de ${store.limit} caracteres excedido`, store, input.target);

	const [keep, ...drop] = rows as [MemoryRow, ...MemoryRow[]];
	const source = changeSourceFor(input.source, input.origin);
	const updated = await prisma.$transaction(async (tx) => {
		const row = await tx.memoryEntry.update({
			where: { id: keep.id },
			data: {
				content,
				category: input.category?.trim() || undefined,
				confidence: input.confidence,
				importance: input.importance,
				source: input.source?.trim() || undefined,
				validUntil: toValidDate(input.validUntil),
			},
		});
		await recordMemoryChange(tx, {
			userId,
			botId: input.botId ?? keep.botId,
			entryId: keep.id,
			target: input.target,
			action: "replace",
			before: keep.content,
			after: content,
			beforeMeta: memoryMetaOf(keep),
			source,
		});
		for (const gone of drop) {
			await tx.memoryEntry.delete({ where: { id: gone.id } });
			await recordMemoryChange(tx, {
				userId,
				botId: input.botId ?? gone.botId,
				entryId: gone.id,
				target: input.target,
				action: "remove",
				before: gone.content,
				beforeMeta: memoryMetaOf(gone),
				source,
			});
		}
		return row;
	});
	await refreshMemoryEmbedding(updated.id, content).catch(() => undefined);
	return { ok: true, entry: toMemoryEntry(updated) };
}

type StoredRow = MemoryRow;

/** Troca o texto de uma entrada já localizada (valida, grava com o histórico e atualiza o vetor). */
async function applyReplace(args: {
	userId: string;
	store: { rows: MemoryRow[]; used: number; limit: number };
	row: StoredRow;
	content: string;
	input: { botId?: string } & MemoryMetadataInput;
}): Promise<MemoryActionResult> {
	const { userId, store, row: target, content, input } = args;
	const memoryTarget = target.target as MemoryTarget;
	if (content.length === 0) {
		return failure("conteúdo vazio", store, memoryTarget);
	}

	const unsafe = detectUnsafe(content);
	if (unsafe) {
		return failure(unsafe, store, memoryTarget);
	}

	const nextUsed = store.used - target.content.length + content.length;
	if (nextUsed > store.limit) {
		return failure(
			`limite de ${store.limit} caracteres excedido`,
			store,
			memoryTarget,
		);
	}

	const embedding = await tryEmbed(content);
	if (embedding) {
		const near = await findNearDuplicate({
			userId,
			botId: target.botId ?? null,
			target: memoryTarget,
			embedding,
			excludeId: target.id,
			limit: 1,
		});
		if (near[0] && near[0].distance < SEMANTIC_DUP_MAX_DISTANCE) {
			return failure("duplicado", store, memoryTarget);
		}
	}

	const row = await prisma.$transaction(async (tx) => {
		const updated = await tx.memoryEntry.update({
			where: { id: target.id },
			data: {
				content,
				category: input.category?.trim() || undefined,
				confidence: input.confidence,
				importance: input.importance,
				source: input.source?.trim() || undefined,
				validUntil: toValidDate(input.validUntil),
			},
		});
		await recordMemoryChange(tx, {
			userId,
			botId: input.botId ?? target.botId,
			entryId: target.id,
			target: memoryTarget,
			action: "replace",
			before: target.content,
			after: content,
			beforeMeta: memoryMetaOf(target),
			source: changeSourceFor(input.source, input.origin),
		});
		return updated;
	});
	if (embedding) {
		await storeEmbedding(row.id, embedding).catch((error) =>
			console.warn("memory embedding store failed", error),
		);
	}

	return { ok: true, entry: toMemoryEntry(row) };
}

export async function removeMemoryEntry(input: {
	userId?: string;
	botId?: string;
	target: MemoryTarget;
	oldText?: string;
	ref?: string;
	origin?: MemoryChangeSource;
}): Promise<MemoryActionResult> {
	const userId = input.userId ?? "default";
	const store = await loadStore(userId, input.botId, input.target);
	const found = locateRow(store, input.target, input);
	if ("fail" in found) return found.fail;
	return applyRemove({ userId, row: found.row, botId: input.botId, origin: input.origin ?? "chat" });
}

/** Apaga uma entrada já localizada e registra a mudança (com o texto e os metadados para desfazer). */
async function applyRemove(args: { userId: string; row: StoredRow; botId?: string; origin: MemoryChangeSource }): Promise<MemoryActionResult> {
	const { userId, row, origin } = args;
	await prisma.$transaction(async (tx) => {
		await tx.memoryEntry.delete({ where: { id: row.id } });
		await recordMemoryChange(tx, {
			userId,
			botId: args.botId ?? row.botId,
			entryId: row.id,
			target: row.target as MemoryTarget,
			action: "remove",
			before: row.content,
			beforeMeta: memoryMetaOf(row),
			source: origin,
		});
	});

	return { ok: true, entry: toMemoryEntry(row) };
}

/** Entrada pelo id, só se for do usuário (lê também a linha legada `default`, como a listagem). */
export async function getMemoryEntryById(userId: string, entryId: string) {
	return prisma.memoryEntry.findFirst({ where: { id: entryId, userId: { in: readUserIds(userId) } } });
}

/** Edita o texto de uma entrada pelo id (aba Memória). Mesmas travas do `replace` da conversa. Null = não existe/não é do usuário. */
export async function replaceMemoryEntryById(input: { userId: string; entryId: string; content: string; origin?: MemoryChangeSource }): Promise<MemoryActionResult | null> {
	const row = await getMemoryEntryById(input.userId, input.entryId);
	if (!row) return null;
	const target = row.target as MemoryTarget;
	const store = await loadStore(input.userId, row.botId ?? undefined, target);
	const content = input.content.trim();
	if (content === row.content) return { ok: true, entry: toMemoryEntry(row) };
	return applyReplace({ userId: input.userId, store, row, content, input: { botId: row.botId ?? undefined, source: "user", origin: input.origin ?? "user" } });
}

/** Apaga uma entrada pelo id (aba Memória). Null = não existe/não é do usuário. */
export async function removeMemoryEntryById(input: { userId: string; entryId: string; origin?: MemoryChangeSource }): Promise<MemoryActionResult | null> {
	const row = await getMemoryEntryById(input.userId, input.entryId);
	if (!row) return null;
	return applyRemove({ userId: input.userId, row, origin: input.origin ?? "user" });
}

/** Recalcula o vetor de uma entrada cujo texto mudou (sem key/falha: apaga o vetor velho para não gerar falso duplicado). */
export async function refreshMemoryEmbedding(id: string, content: string): Promise<void> {
	await prisma.$executeRaw`UPDATE memory_entries SET embedding = NULL WHERE id = ${id}`;
	const embedding = await tryEmbed(content);
	if (embedding) await storeEmbedding(id, embedding).catch((error) => console.warn("memory embedding store failed", error));
}

/**
 * Memória do bot como entra no prompt sem pergunta para ranquear: sem vencidas nem `[RESOLVIDA]` e,
 * se passar do orçamento padrão (2200), só as mais importantes/recentes. O limite maior do
 * orquestrador define quanto cabe guardado; o prompt continua limitado.
 */
export function promptMemoryView(view: MemoryStoreView, now: Date = new Date(), budget: number = MEMORY_CHAR_LIMIT): MemoryStoreView {
	const live = view.entries.filter(
		(entry) => entry.category !== "pendencia-resolvida" && !entry.content.trimStart().startsWith("[RESOLVIDA") && (!entry.validUntil || new Date(entry.validUntil).getTime() > now.getTime()),
	);
	const total = live.reduce((sum, entry) => sum + entry.content.length, 0);
	if (total <= budget) return { ...view, entries: live };
	const ranked = [...live].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.updatedAt.localeCompare(a.updatedAt));
	const keep = new Set<string>();
	let used = 0;
	for (const entry of ranked) {
		if (used + entry.content.length > budget) continue;
		used += entry.content.length;
		keep.add(entry.id);
	}
	return { ...view, entries: live.filter((entry) => keep.has(entry.id)) };
}
