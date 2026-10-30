import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./client.js";
import type { Prisma } from "@prisma/client";
import { fileExtension, sanitizeFilename, sniffImageMime } from "@workspace/shared";
import { ownerIds } from "./mcp-connections.js";

function artifactRoot(): string {
	return process.env.ATLAS_ARTIFACT_DIR?.trim() || join(tmpdir(), "atlas-artifacts");
}

/**
 * Linha de log de inicialização (api e worker) com o diretório de artefatos em uso. Em produção, cair no `tmpdir`
 * significa arquivos fora do volume compartilhado: o worker não lê o que a api gravou (e a imagem some do run).
 */
export function describeArtifactDir(env: Record<string, string | undefined> = process.env): {
	level: "info" | "warn";
	dir: string;
	fallback: boolean;
	message: string;
} {
	const configured = env.ATLAS_ARTIFACT_DIR?.trim();
	const dir = configured || join(tmpdir(), "atlas-artifacts");
	if (configured) return { level: "info", dir, fallback: false, message: `[artifacts] ATLAS_ARTIFACT_DIR=${dir}` };
	if (env.NODE_ENV === "production") {
		return {
			level: "warn",
			dir,
			fallback: true,
			message: `[artifacts] ATENÇÃO: ATLAS_ARTIFACT_DIR não definido em produção; usando ${dir} (tmpdir). Api e worker NÃO compartilham esse caminho: anexos e imagens ficam ilegíveis para o worker e somem num redeploy. Monte o volume atlas-artifacts nos dois serviços e defina o mesmo ATLAS_ARTIFACT_DIR.`,
		};
	}
	return { level: "info", dir, fallback: true, message: `[artifacts] ATLAS_ARTIFACT_DIR não definido; usando ${dir} (tmpdir, só para desenvolvimento)` };
}

/** Escreve a linha de `describeArtifactDir` no console (`warn` quando o fallback é perigoso). */
export function logArtifactDir(env: Record<string, string | undefined> = process.env): void {
	const { level, message } = describeArtifactDir(env);
	if (level === "warn") console.warn(message);
	else console.info(message);
}

/** Tipos de artefato com dono direto; cada um com o seu teto de bytes. */
export type UserArtifactKind = "file" | "image" | "tool_result";

/** Arquivo gerado (F9) 20 MB; imagem (F14) 10 MB; resultado grande de tool guardado por referência (F6) 2 MB. */
export const ARTIFACT_MAX_BYTES: Record<UserArtifactKind, number> = {
	file: 20 * 1024 * 1024,
	image: 10 * 1024 * 1024,
	tool_result: 2 * 1024 * 1024,
};

/** Nome seguro para guardar/baixar: sem caminho nem `..`, até 120 chars. */
export function sanitizeArtifactName(name: string): string {
	return sanitizeFilename(name);
}

/** Pasta do dono no disco: só [A-Za-z0-9_-], nunca vem cru do cliente. */
function ownerDirName(userId: string): string {
	return userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";
}

function diskExtension(meta: Record<string, unknown>, mime: string): string {
	const fromName = typeof meta.filename === "string" ? fileExtension(meta.filename) : "";
	const fromMeta = typeof meta.ext === "string" ? meta.ext.toLowerCase() : "";
	const ext = fromMeta || fromName;
	if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
	if (mime.startsWith("image/")) return mime === "image/jpeg" ? "jpg" : mime.slice(6).replace(/[^a-z0-9]/g, "") || "img";
	return "bin";
}

export type PersistUserArtifactInput = {
	/** Dono vindo da sessão (nunca do body). */
	userId: string;
	runId?: string | null;
	conversationId?: string | null;
	kind: UserArtifactKind;
	bytes: Uint8Array;
	mime: string;
	meta?: Record<string, unknown>;
};

export type UserArtifact = {
	id: string;
	kind: string;
	/** Metadados guardados (sempre com `mime` e `size`). */
	meta: Record<string, unknown> & { mime: string };
	runId: string | null;
	conversationId: string | null;
	createdAt: Date;
};

/**
 * Grava um artefato de dono direto: `<ATLAS_ARTIFACT_DIR>/<dono>/<id>.<ext>`,
 * caminho montado no servidor. Nunca loga os bytes.
 */
export async function persistUserArtifact(input: PersistUserArtifactInput): Promise<UserArtifact> {
	if (!input.userId || input.userId === "default") throw new Error("artefato precisa de um dono");
	const limit = ARTIFACT_MAX_BYTES[input.kind];
	if (input.bytes.byteLength === 0) throw new Error("artefato vazio");
	if (input.bytes.byteLength > limit) {
		throw new Error(`artefato acima do limite de ${Math.round(limit / 1024 / 1024)} MB`);
	}
	// Run e conversa referenciados precisam ser do mesmo dono (nunca confiar no id).
	const owners = ownerIds(input.userId);
	if (input.runId) {
		const run = await prisma.agentRun.findFirst({ where: { id: input.runId, userId: { in: owners } }, select: { id: true } });
		if (!run) throw new Error("run não encontrado");
	}
	if (input.conversationId) {
		const conversation = await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: { in: owners } }, select: { id: true } });
		if (!conversation) throw new Error("conversa não encontrada");
	}
	const meta = { ...(input.meta ?? {}), mime: input.mime, size: input.bytes.byteLength };
	const row = await prisma.artifact.create({
		data: {
			userId: input.userId,
			runId: input.runId ?? null,
			conversationId: input.conversationId ?? null,
			kind: input.kind,
			uri: "",
			metaJson: meta as Prisma.InputJsonValue,
		},
	});
	try {
		const dir = join(artifactRoot(), ownerDirName(input.userId));
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, `${row.id}.${diskExtension(meta, input.mime)}`);
		await writeFile(filePath, input.bytes);
		await prisma.artifact.update({ where: { id: row.id }, data: { uri: filePath } });
	} catch (error) {
		await prisma.artifact.delete({ where: { id: row.id } }).catch(() => undefined);
		throw error;
	}
	return {
		id: row.id,
		kind: input.kind,
		meta,
		runId: row.runId,
		conversationId: row.conversationId,
		createdAt: row.createdAt,
	};
}

/** Por que a leitura falhou: só o motivo e o errno, nunca conteúdo nem dado do usuário (vai para o log). */
export type ArtifactLoadFailure = "not_found_for_owner" | "empty_uri" | `read_failed:${string}`;

export type ArtifactLoadResult =
	| { ok: true; artifact: UserArtifact & { bytes: Buffer } }
	| { ok: false; reason: ArtifactLoadFailure };

/**
 * Lê um artefato do dono e, se falhar, diz o motivo (para o worker logar). Dono = `userId` da linha ou, na falta
 * dele, o dono do run (screenshots antigos). Outro usuário e id inexistente dão o mesmo `not_found_for_owner`.
 */
export async function loadArtifactForUserDetailed(artifactId: string, userId: string): Promise<ArtifactLoadResult> {
	if (!artifactId || !userId) return { ok: false, reason: "not_found_for_owner" };
	const owners = ownerIds(userId);
	const row = await prisma.artifact.findFirst({
		where: {
			id: artifactId,
			OR: [{ userId: { in: owners } }, { userId: null, run: { userId: { in: owners } } }],
		},
	});
	if (!row) return { ok: false, reason: "not_found_for_owner" };
	if (!row.uri) return { ok: false, reason: "empty_uri" };
	let bytes: Buffer;
	try {
		bytes = await readFile(row.uri);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return { ok: false, reason: `read_failed:${typeof code === "string" && code ? code : "UNKNOWN"}` };
	}
	const stored = (row.metaJson && typeof row.metaJson === "object" && !Array.isArray(row.metaJson)
		? row.metaJson
		: {}) as Record<string, unknown>;
	const mime = typeof stored.mime === "string" ? stored.mime : "application/octet-stream";
	return {
		ok: true,
		artifact: {
			id: row.id,
			kind: row.kind,
			meta: { ...stored, mime },
			runId: row.runId,
			conversationId: row.conversationId,
			createdAt: row.createdAt,
			bytes,
		},
	};
}

/**
 * Lê um artefato do dono. Outro usuário, id inexistente ou arquivo sumido viram `null` (a rota responde 404 sem
 * revelar existência). Quem precisa do motivo usa `loadArtifactForUserDetailed`.
 */
export async function loadArtifactForUser(
	artifactId: string,
	userId: string,
): Promise<(UserArtifact & { bytes: Buffer }) | null> {
	const result = await loadArtifactForUserDetailed(artifactId, userId);
	return result.ok ? result.artifact : null;
}

/** Atualiza a descrição (usada pelo fallback de visão). Só do dono; false = não achou. */
export async function setArtifactDescriptionForUser(id: string, userId: string, description: string): Promise<boolean> {
	const owners = ownerIds(userId);
	const row = await prisma.artifact.findFirst({
		where: { id, OR: [{ userId: { in: owners } }, { userId: null, run: { userId: { in: owners } } }] },
		select: { id: true, metaJson: true },
	});
	if (!row) return false;
	const meta = row.metaJson && typeof row.metaJson === "object" && !Array.isArray(row.metaJson) ? row.metaJson as Record<string, unknown> : {};
	await prisma.artifact.update({ where: { id: row.id }, data: { metaJson: { ...meta, description: description.slice(0, 1000) } as Prisma.InputJsonValue } });
	return true;
}

/**
 * Carrega um artefato de tool_result da mesma conversa e dono, ignorando o run.
 * Usado por artifact_read para permitir leitura de resultados de runs anteriores.
 * Escalação de segurança: userId garantido no filtro, nunca do argumento.
 */
export async function loadArtifactFromConversation(
	artifactId: string,
	userId: string,
	conversationId: string,
): Promise<(UserArtifact & { bytes: Buffer }) | null> {
	if (!artifactId || !userId || !conversationId) return null;
	const owners = ownerIds(userId);
	const row = await prisma.artifact.findFirst({
		where: {
			id: artifactId,
			conversationId,
			userId: { in: owners },
			kind: "tool_result",
		},
	});
	if (!row?.uri) return null;
	let bytes: Buffer;
	try {
		bytes = await readFile(row.uri);
	} catch {
		return null;
	}
	const stored = (row.metaJson && typeof row.metaJson === "object" && !Array.isArray(row.metaJson)
		? row.metaJson
		: {}) as Record<string, unknown>;
	const mime = typeof stored.mime === "string" ? stored.mime : "application/octet-stream";
	return {
		id: row.id,
		kind: row.kind,
		meta: { ...stored, mime },
		runId: row.runId,
		conversationId: row.conversationId,
		createdAt: row.createdAt,
		bytes,
	};
}

/**
 * Lista artefatos de tool_result recentes da conversa para o dono,
 * sem conteúdo. Usados para sugerir leitura de runs anteriores.
 */
export async function listConversationArtifacts(
	userId: string,
	conversationId: string,
	options?: { limit?: number; excludeRunId?: string },
): Promise<Array<{ id: string; name?: string; kind: string }>> {
	if (!userId || !conversationId) return [];
	const owners = ownerIds(userId);
	const limit = options?.limit ?? 5;
	const rows = await prisma.artifact.findMany({
		where: {
			conversationId,
			userId: { in: owners },
			kind: "tool_result",
			...(options?.excludeRunId ? { runId: { not: options.excludeRunId } } : {}),
		},
		select: {
			id: true,
			metaJson: true,
			kind: true,
		},
		orderBy: { createdAt: "desc" },
		take: limit,
	});
	return rows.map((row) => {
		const meta = (row.metaJson && typeof row.metaJson === "object" && !Array.isArray(row.metaJson)
			? row.metaJson
			: {}) as Record<string, unknown>;
		const name = typeof meta.name === "string" ? meta.name : typeof meta.filename === "string" ? meta.filename : "";
		return { id: row.id, name: name || undefined, kind: row.kind };
	});
}

/**
 * Ids das imagens geradas (`generate_image`) na conversa, da mais recente para a mais antiga. O dono vem
 * da sessão, nunca de argumento: imagem de outro usuário não aparece.
 */
export async function listGeneratedImageIds(userId: string, conversationId: string, limit = 5): Promise<string[]> {
	if (!userId || !conversationId) return [];
	const rows = await prisma.artifact.findMany({
		where: {
			conversationId,
			userId: { in: ownerIds(userId) },
			kind: "image",
			metaJson: { path: ["source"], equals: "generated" },
		},
		select: { id: true },
		orderBy: { createdAt: "desc" },
		take: Math.min(Math.max(1, limit), 10),
	});
	return rows.map((row) => row.id);
}

/**
 * Próxima versão de um arquivo gerado: mesmo nome na mesma conversa (ou, sem
 * conversa, no mesmo run) sobe `version`. Sempre escopado pelo dono.
 */
export async function nextFileVersion(input: {
	userId: string;
	conversationId?: string | null;
	runId?: string | null;
	filename: string;
}): Promise<number> {
	const scope = input.conversationId
		? { conversationId: input.conversationId }
		: input.runId
			? { runId: input.runId }
			: null;
	if (!scope) return 1;
	const previous = await prisma.artifact.findFirst({
		where: {
			userId: input.userId,
			kind: "file",
			...scope,
			metaJson: { path: ["filename"], equals: input.filename },
		},
		orderBy: { createdAt: "desc" },
	});
	const meta = previous?.metaJson as { version?: unknown } | null | undefined;
	return typeof meta?.version === "number" ? Math.floor(meta.version) + 1 : previous ? 2 : 1;
}

/** Arquivos já gerados neste run (limite por run, também numa retomada). */
export async function countRunFileArtifacts(runId: string, userId: string): Promise<number> {
	return prisma.artifact.count({ where: { runId, userId, kind: "file" } });
}

export async function persistScreenshotArtifact(input: {
	runId: string;
	pngBase64: string;
}): Promise<string> {
	// O nome do parâmetro é histórico: screenshots do modelo agora são JPEG.
	const bytes = Buffer.from(input.pngBase64, "base64");
	const mime = sniffImageMime(bytes);
	const row = await prisma.artifact.create({
		data: {
			runId: input.runId,
			kind: "screenshot",
			uri: "",
			metaJson: { mime } as Prisma.InputJsonValue,
		},
	});

	const dir = join(artifactRoot(), input.runId);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${row.id}.${mime === "image/jpeg" ? "jpg" : "png"}`);
	await writeFile(filePath, bytes);
	await prisma.artifact.update({
		where: { id: row.id },
		data: { uri: filePath },
	});
	return row.id;
}

export async function loadScreenshotArtifact(
	artifactId: string,
	userId?: string,
): Promise<string | null> {
	// Com userId (rota): dono checado na query; IDOR vira null (a rota responde
	// 404). Sem userId (worker, run que acabou de gravar o artefato) lê direto.
	if (userId) {
		const owned = await loadArtifactForUser(artifactId, userId);
		if (!owned || owned.kind !== "screenshot") return null;
		return `data:${sniffImageMime(owned.bytes)};base64,${owned.bytes.toString("base64")}`;
	}
	const row = await prisma.artifact.findUnique({ where: { id: artifactId } });
	if (!row?.uri) return null;
	try {
		const buffer = await readFile(row.uri);
		return `data:${sniffImageMime(buffer)};base64,${buffer.toString("base64")}`;
	} catch {
		return null;
	}
}

/**
 * Variante explícita para rotas: retorna null quando o artifact não existe
 * ou o run não é do usuário (a rota responde 404 nos dois casos,
 * sem vazar existência).
 */
export async function loadScreenshotArtifactForUser(
	artifactId: string,
	userId: string,
): Promise<string | null> {
	return loadScreenshotArtifact(artifactId, userId);
}

export type BotLibraryFile = {
	id: string;
	filename: string;
	size: number;
	version: number;
	mime: string;
	createdAt: string;
};

/**
 * Arquivos (kind `file`) criados por um bot do dono, mais novos primeiro: os da
 * conversa própria do bot ou de runs dele. `null` = bot inexistente/de outro
 * dono. `cursor` = ISO do `createdAt` do último item da página anterior.
 */
export async function listBotArtifactsForUser(input: {
	userId: string;
	botId: string;
	limit?: number;
	cursor?: string | null;
}): Promise<{ files: BotLibraryFile[]; nextCursor: string | null } | null> {
	const userId = input.userId?.trim();
	if (!userId || userId === "default" || !input.botId) return null;
	const bot = await prisma.bot.findFirst({
		where: { id: input.botId, ownerId: userId },
		select: { id: true, conversationId: true },
	});
	if (!bot) return null;
	const limit = Math.min(Math.max(Math.trunc(input.limit ?? 30) || 30, 1), 100);
	const before = input.cursor ? new Date(input.cursor) : null;
	const owners = ownerIds(userId);
	const scope: Prisma.ArtifactWhereInput[] = [{ run: { botId: bot.id } }];
	if (bot.conversationId) scope.push({ conversationId: bot.conversationId });
	const rows = await prisma.artifact.findMany({
		where: {
			userId: { in: owners },
			kind: "file",
			OR: scope,
			...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
		},
		orderBy: { createdAt: "desc" },
		take: limit + 1,
	});
	const page = rows.slice(0, limit);
	const files = page.map((row): BotLibraryFile => {
		const meta = (row.metaJson && typeof row.metaJson === "object" && !Array.isArray(row.metaJson)
			? row.metaJson
			: {}) as Record<string, unknown>;
		const mime = typeof meta.mime === "string" ? meta.mime : "application/octet-stream";
		const filename = typeof meta.filename === "string" && meta.filename.trim() ? meta.filename : `${row.id}.bin`;
		return {
			id: row.id,
			filename,
			size: typeof meta.size === "number" ? meta.size : 0,
			version: typeof meta.version === "number" ? Math.max(1, Math.floor(meta.version)) : 1,
			mime,
			createdAt: row.createdAt.toISOString(),
		};
	});
	const last = page[page.length - 1];
	return { files, nextCursor: rows.length > limit && last ? last.createdAt.toISOString() : null };
}

const SIDECAR_NAME = /^[a-z0-9-]{1,24}$/;
const SIDECAR_MAX_BYTES = 16 * 1024 * 1024;

async function sidecarPath(artifactId: string, userId: string, name: string): Promise<string | null> {
	if (!artifactId || !userId || userId === "default" || !SIDECAR_NAME.test(name)) return null;
	const row = await prisma.artifact.findFirst({
		where: { id: artifactId, kind: "file", userId: { in: ownerIds(userId) } },
		select: { uri: true },
	});
	return row?.uri ? `${row.uri}.${name}.json` : null;
}

/**
 * Derivado de um arquivo guardado (ex.: texto extraído), gravado ao lado dele no storage, sem
 * tabela nem migration. Só do dono; ausente ou ilegível vira `null`.
 */
export async function readArtifactSidecar(artifactId: string, userId: string, name: string): Promise<string | null> {
	const path = await sidecarPath(artifactId, userId, name);
	if (!path) return null;
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** Grava o derivado (troca atômica por arquivo temporário). `false` = não é do dono, grande demais ou falhou. */
export async function writeArtifactSidecar(artifactId: string, userId: string, name: string, content: string): Promise<boolean> {
	if (Buffer.byteLength(content) > SIDECAR_MAX_BYTES) return false;
	const path = await sidecarPath(artifactId, userId, name);
	if (!path) return false;
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temp, content, "utf8");
		await rename(temp, path);
		return true;
	} catch {
		await rm(temp, { force: true }).catch(() => undefined);
		return false;
	}
}
