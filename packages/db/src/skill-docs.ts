/**
 * Skills em Markdown (PLANO-SKILLS K0). Toda função recebe o `userId` da
 * sessão e filtra por ele na própria query (`where: { id, userId }`); recurso
 * de outro dono é indistinguível de inexistente (null / false / not_found,
 * que a API responde como 404). O legado `"default"` nunca é dono válido aqui:
 * não lê nem grava.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
	SKILL_MAX_PER_SCOPE,
	SKILL_MAX_PER_USER,
	SKILL_REVISIONS_KEPT,
	mergeSkillScopes,
	redactSecrets,
	validateSkillFields,
	type SkillCreator,
	type SkillIndexEntry,
	type SkillProvenance,
	type SkillSource,
	type SkillStatus,
} from "@workspace/shared";
import { prisma } from "./client.js";

export type SkillDocErrorKind = "invalid" | "conflict" | "limit" | "stale" | "not_found";

/** Erro previsível; a mensagem é pt-BR e própria para o usuário. */
export class SkillDocError extends Error {
	constructor(
		readonly kind: SkillDocErrorKind,
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
		this.name = "SkillDocError";
	}
}

export type SkillDocRecord = {
	id: string;
	botId: string | null;
	name: string;
	description: string;
	body: string;
	tools: string[];
	enabled: boolean;
	createdBy: SkillCreator;
	status: SkillStatus;
	revision: number;
	/** Origem do catálogo (null = skill própria). `edited`: o conteúdo atual difere do instalado. */
	source: SkillProvenance | null;
	createdAt: Date;
	updatedAt: Date;
};

type Row = {
	id: string;
	botId: string | null;
	name: string;
	description: string;
	body: string;
	tools: string[];
	enabled: boolean;
	createdBy: string;
	status: string;
	revision: number;
	sourceKind?: string | null;
	sourceSlug?: string | null;
	sourceVersion?: string | null;
	sourceHash?: string | null;
	createdAt: Date;
	updatedAt: Date;
};

/** Hash do que a skill ensina (descrição, tools, corpo): detecta edição depois da instalação. */
export function skillContentHash(fields: { description: string; tools: readonly string[]; body: string }): string {
	return createHash("sha256")
		.update(JSON.stringify([fields.description, [...fields.tools], fields.body]))
		.digest("hex");
}

function toSource(row: Row): SkillProvenance | null {
	if (row.sourceKind !== "catalog" || !row.sourceSlug || !row.sourceVersion) return null;
	return { kind: "catalog", slug: row.sourceSlug, version: row.sourceVersion, edited: skillContentHash(row) !== row.sourceHash };
}

function toRecord(row: Row): SkillDocRecord {
	return {
		id: row.id,
		botId: row.botId,
		name: row.name,
		description: row.description,
		body: row.body,
		tools: row.tools,
		enabled: row.enabled,
		createdBy: row.createdBy === "agent" ? "agent" : "user",
		status: row.status === "draft" ? "draft" : "active",
		revision: row.revision,
		source: toSource(row),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Dono válido: a sessão sempre traz um id real, nunca vazio nem o legado. */
function validOwner(userId: string | undefined): string | null {
	const id = userId?.trim();
	return id && id !== "default" ? id : null;
}

function requireOwner(userId: string | undefined): string {
	const owner = validOwner(userId);
	if (!owner) throw new SkillDocError("not_found", "Skill não encontrada.");
	return owner;
}

export type SkillDocInput = {
	botId?: string | null;
	name: unknown;
	description: unknown;
	body: unknown;
	tools?: unknown;
	enabled?: boolean;
	createdBy?: SkillCreator;
	status?: SkillStatus;
	/** Instalação do catálogo: o hash é calculado aqui, sobre o conteúdo já normalizado. */
	source?: Omit<SkillSource, "hash">;
};

/** Valida e redige segredos (descrição e corpo) antes de gravar. */
function normalizeFields(input: { name: unknown; description: unknown; body: unknown; tools?: unknown }) {
	const parsed = validateSkillFields(input);
	if (!parsed.ok) {
		throw new SkillDocError("invalid", parsed.errors.join(" "), parsed.errors);
	}
	const { skill } = parsed;
	return { ...skill, description: redactSecrets(skill.description), body: redactSecrets(skill.body) };
}

/** Colunas de origem para gravar; `null` limpa a origem. */
function sourceColumns(
	source: Omit<SkillSource, "hash"> | null | undefined,
	fields: { description: string; tools: string[]; body: string },
) {
	if (source === undefined) return {};
	if (source === null) return { sourceKind: null, sourceSlug: null, sourceVersion: null, sourceHash: null };
	return { sourceKind: source.kind, sourceSlug: source.slug, sourceVersion: source.version, sourceHash: skillContentHash(fields) };
}

function nameClash(name: string) {
	return new SkillDocError("conflict", `Já existe uma skill chamada "${name}" neste escopo.`);
}

function staleEdit() {
	return new SkillDocError("stale", "A skill foi alterada por outra edição. Recarregue e tente de novo.");
}

async function assertNameFree(userId: string, botId: string | null, name: string, exceptId?: string) {
	const clash = await prisma.skillDoc.findFirst({
		where: { userId, botId, name, ...(exceptId ? { id: { not: exceptId } } : {}) },
		select: { id: true },
	});
	if (clash) throw nameClash(name);
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function countSkillDocs(userId: string, botId?: string | null): Promise<number> {
	const owner = validOwner(userId);
	if (!owner) return 0;
	return prisma.skillDoc.count({ where: { userId: owner, ...(botId === undefined ? {} : { botId }) } });
}

/**
 * Lista do dono. `botId` indefinido = todas; `null` = só de conta; string =
 * só daquele bot.
 */
export async function listSkillDocs(userId: string, opts: { botId?: string | null } = {}): Promise<SkillDocRecord[]> {
	const owner = validOwner(userId);
	if (!owner) return [];
	const rows = await prisma.skillDoc.findMany({
		where: { userId: owner, ...(opts.botId === undefined ? {} : { botId: opts.botId }) },
		orderBy: { name: "asc" },
	});
	return rows.map(toRecord);
}

export async function getSkillDoc(userId: string, id: string): Promise<SkillDocRecord | null> {
	const owner = validOwner(userId);
	if (!owner || !id) return null;
	const row = await prisma.skillDoc.findFirst({ where: { id, userId: owner } });
	return row ? toRecord(row) : null;
}

async function activeRows(owner: string, botId: string | null): Promise<Row[]> {
	return prisma.skillDoc.findMany({
		where: { userId: owner, botId, enabled: true, status: "active" },
		orderBy: { name: "asc" },
	});
}

/**
 * Entradas do índice do prompt: conta + bot do run, só ativas e habilitadas,
 * a do bot vence na colisão de nome. Ordem e teto ficam no `buildSkillIndex`.
 */
export async function listSkillDocsForIndex(userId: string, botId?: string | null): Promise<SkillIndexEntry[]> {
	const owner = validOwner(userId);
	if (!owner) return [];
	const toEntry = (row: Row): SkillIndexEntry => ({ name: row.name, description: row.description, enabled: true, status: "active" });
	const account = (await activeRows(owner, null)).map(toEntry);
	const bot = botId ? (await activeRows(owner, botId)).map(toEntry) : [];
	return mergeSkillScopes(account, bot);
}

/** Corpo por nome para `skill_read`: bot antes da conta; só ativa e habilitada. */
export async function readSkillDocByName(userId: string, name: string, botId?: string | null): Promise<SkillDocRecord | null> {
	const owner = validOwner(userId);
	if (!owner || !name) return null;
	const scopes: Array<string | null> = botId ? [botId, null] : [null];
	for (const scope of scopes) {
		const row = await prisma.skillDoc.findFirst({
			where: { userId: owner, botId: scope, name, enabled: true, status: "active" },
		});
		if (row) return toRecord(row);
	}
	return null;
}

export async function createSkillDoc(userId: string, input: SkillDocInput): Promise<SkillDocRecord> {
	const owner = requireOwner(userId);
	const botId = input.botId?.trim() || null;
	const fields = normalizeFields(input);
	if (botId && !(await prisma.bot.findFirst({ where: { id: botId, ownerId: owner }, select: { id: true } }))) {
		throw new SkillDocError("not_found", "Bot não encontrado.");
	}

	if ((await countSkillDocs(owner, botId)) >= SKILL_MAX_PER_SCOPE) {
		throw new SkillDocError("limit", `Limite de ${SKILL_MAX_PER_SCOPE} skills por escopo atingido.`);
	}
	if ((await countSkillDocs(owner)) >= SKILL_MAX_PER_USER) {
		throw new SkillDocError("limit", `Limite de ${SKILL_MAX_PER_USER} skills por conta atingido.`);
	}
	await assertNameFree(owner, botId, fields.name);

	try {
		const row = await prisma.skillDoc.create({
			data: {
				userId: owner,
				botId,
				name: fields.name,
				description: fields.description,
				body: fields.body,
				tools: fields.tools,
				enabled: input.enabled ?? input.status !== "draft",
				createdBy: input.createdBy ?? "user",
				status: input.status ?? "active",
				...sourceColumns(input.source, fields),
			},
		});
		return toRecord(row);
	} catch (error) {
		if (isUniqueViolation(error)) throw nameClash(fields.name);
		throw error;
	}
}

export type SkillDocPatch = {
	name?: unknown;
	description?: unknown;
	body?: unknown;
	tools?: unknown;
	status?: SkillStatus;
	enabled?: boolean;
	/** Se informada, a edição só vale sobre essa revisão (evita sobrescrever). */
	expectedRevision?: number;
	updatedBy?: SkillCreator;
	/** Atualização vinda do catálogo: regrava a origem com o hash do conteúdo novo. */
	source?: Omit<SkillSource, "hash"> | null;
};

/**
 * Edita o conteúdo. Guarda o estado anterior em `SkillRevision` (poda as
 * últimas N) e incrementa `revision` só se ninguém alterou no meio.
 */
export async function updateSkillDoc(userId: string, id: string, patch: SkillDocPatch): Promise<SkillDocRecord> {
	const owner = requireOwner(userId);
	const found = await prisma.skillDoc.findFirst({ where: { id, userId: owner } });
	const current = found && { ...found };
	if (!current) throw new SkillDocError("not_found", "Skill não encontrada.");
	if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) throw staleEdit();

	const fields = normalizeFields({
		name: patch.name ?? current.name,
		description: patch.description ?? current.description,
		body: patch.body ?? current.body,
		tools: patch.tools ?? current.tools,
	});
	if (fields.name !== current.name) await assertNameFree(owner, current.botId, fields.name, current.id);

	try {
		return await prisma.$transaction(async (tx) => {
			const claimed = await tx.skillDoc.updateMany({
				where: { id: current.id, userId: owner, revision: current.revision },
				data: {
					name: fields.name,
					description: fields.description,
					body: fields.body,
					tools: fields.tools,
					...(patch.status ? { status: patch.status } : {}),
					...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
					...sourceColumns(patch.source, fields),
					revision: { increment: 1 },
				},
			});
			if (claimed.count !== 1) throw staleEdit();
			await tx.skillRevision.create({
				data: {
					skillId: current.id,
					userId: owner,
					revision: current.revision,
					name: current.name,
					description: current.description,
					body: current.body,
					createdBy: patch.updatedBy ?? current.createdBy,
				},
			});
			await tx.skillRevision.deleteMany({
				where: { skillId: current.id, userId: owner, revision: { lte: current.revision - SKILL_REVISIONS_KEPT } },
			});
			const row = await tx.skillDoc.findFirst({ where: { id: current.id, userId: owner } });
			if (!row) throw new SkillDocError("not_found", "Skill não encontrada.");
			return toRecord(row);
		});
	} catch (error) {
		if (isUniqueViolation(error)) throw nameClash(fields.name);
		throw error;
	}
}

/** Liga/desliga sem criar revisão (não muda conteúdo). `false` se não for do dono. */
export async function setSkillDocEnabled(userId: string, id: string, enabled: boolean): Promise<boolean> {
	const owner = validOwner(userId);
	if (!owner) return false;
	const result = await prisma.skillDoc.updateMany({ where: { id, userId: owner }, data: { enabled } });
	return result.count === 1;
}

/** Apaga (as revisões vão junto por cascade). `false` se não for do dono. */
export async function deleteSkillDoc(userId: string, id: string): Promise<boolean> {
	const owner = validOwner(userId);
	if (!owner) return false;
	const result = await prisma.skillDoc.deleteMany({ where: { id, userId: owner } });
	return result.count === 1;
}

/**
 * Apaga só os RASCUNHOS do dono e devolve quantos foram. `botId` indefinido =
 * todos os escopos; `null` = só os da conta; string = só os daquele bot.
 */
export async function deleteDraftSkillDocs(userId: string, opts: { botId?: string | null } = {}): Promise<number> {
	const owner = validOwner(userId);
	if (!owner) return 0;
	const result = await prisma.skillDoc.deleteMany({
		where: { userId: owner, status: "draft", ...(opts.botId === undefined ? {} : { botId: opts.botId }) },
	});
	return result.count;
}

export type SkillRevisionRecord = {
	revision: number;
	name: string;
	description: string;
	body: string;
	createdBy: string;
	createdAt: Date;
};

/** Últimas revisões (mais nova primeiro) de uma skill do dono. */
export async function listSkillRevisions(userId: string, id: string): Promise<SkillRevisionRecord[]> {
	const owner = validOwner(userId);
	if (!owner) return [];
	const rows = await prisma.skillRevision.findMany({
		where: { skillId: id, userId: owner },
		orderBy: { revision: "desc" },
		take: SKILL_REVISIONS_KEPT,
	});
	return rows.map(({ revision, name, description, body, createdBy, createdAt }) => ({
		revision,
		name,
		description,
		body,
		createdBy,
		createdAt,
	}));
}
