import { createHash } from "node:crypto";

/**
 * Cache de ambiente: um volume Docker por (usuário, repositório) com as
 * dependências já instaladas (`node_modules`, `.venv`), montado em /envcache.
 * Uma sessão nova do mesmo ambiente restaura o volume em vez de instalar tudo
 * de novo; os caches do gerenciador de pacotes (/cache) continuam por usuário.
 *
 * Modelo de ameaça:
 * - O volume é por usuário + repositório (o nome vem de um hash dos dois). Nunca é
 *   montado em sessão de outro usuário, então um cache envenenado não atravessa contas.
 * - Segredos nunca aparecem em nome, label ou metadado: só um hash salgado (usuário+repo)
 *   dos pares NOME=valor entra na chave. O volume guarda apenas diretórios de dependência
 *   ignorados pelo git; nenhum `.env` ou arquivo de configuração é arquivado.
 * - Mudou o comando de instalação, a imagem ou algum segredo/variável: o cache é descartado
 *   (rebuild), porque scripts de instalação podem ter embutido valores dos segredos antigos.
 *   Mudou só o lockfile: restaura e instala por cima (rápido).
 * - Nada disso vira imagem (`docker commit`), então env/segredos do container nunca são
 *   persistidos na configuração de uma imagem.
 */

export const ENV_CACHE_MOUNT = "/envcache";
export const ENV_CACHE_VOLUME_PREFIX = "atlas-dev-envcache-";
export const ENV_CACHE_LABEL = "atlas.dev-sandbox.envCache";

/** Identificador estável (hash) de um ambiente de um usuário. */
export function envCacheId(userId: string, repo: string): string {
	return createHash("sha256").update(`${userId}:${repo.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}

export function envCacheVolumeName(userId: string, repo: string): string {
	return `${ENV_CACHE_VOLUME_PREFIX}${envCacheId(userId, repo)}`;
}

export type EnvCacheParts = {
	/** Hash do comando de instalação. */
	install: string;
	/** Hash do conteúdo de todos os lockfiles. */
	lock: string;
	/** Versão da imagem + node + arquitetura. */
	runtime: string;
	/** Hash salgado de NOME=valor das variáveis/segredos do ambiente. */
	env: string;
};

export type EnvCacheMeta = { key: string; parts: EnvCacheParts; savedAt: number };

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Hash dos pares NOME=valor, salgado por usuário+repo. Os valores nunca saem em claro. */
export function hashEnvVars(vars: Record<string, string>, salt: string): string {
	const pairs = Object.keys(vars)
		.sort()
		.map((name) => [name, vars[name]]);
	return sha(`${salt}|${JSON.stringify(pairs)}`).slice(0, 32);
}

export function computeEnvCacheKey(input: {
	userId: string;
	repo: string;
	installCommand: string;
	/** Hash do conteúdo dos lockfiles (calculado no container). */
	lockHash: string;
	/** Imagem + node + arquitetura (calculado no container). */
	runtime: string;
	/** Variáveis/segredos do ambiente (sem tokens efêmeros do GitHub). */
	env: Record<string, string>;
}): { key: string; parts: EnvCacheParts } {
	const parts: EnvCacheParts = {
		install: sha(input.installCommand.trim()).slice(0, 32),
		lock: input.lockHash.trim(),
		runtime: sha(input.runtime.trim()).slice(0, 32),
		env: hashEnvVars(input.env, envCacheId(input.userId, input.repo)),
	};
	return { key: sha([parts.install, parts.lock, parts.runtime, parts.env].join("|")).slice(0, 40), parts };
}

export type EnvCacheAction = "off" | "miss" | "hit" | "stale" | "rebuild";

export type EnvCacheDecision = {
	action: EnvCacheAction;
	/** Restaurar as dependências salvas antes de instalar. */
	restore: boolean;
	/** Apagar o conteúdo antigo do volume antes de instalar. */
	clear: boolean;
	/** Salvar o resultado depois de uma instalação bem-sucedida. */
	save: boolean;
};

/**
 * - sem cache salvo: instala e salva (miss);
 * - comando, imagem ou segredos mudaram: descarta e reinstala do zero (rebuild);
 * - só o lockfile mudou: restaura e instala por cima (stale);
 * - tudo igual: restaura e roda a instalação como manutenção (hit), sem salvar de novo.
 */
export function decideEnvCache(input: { enabled: boolean; available: boolean; saved: EnvCacheMeta | null; current: { key: string; parts: EnvCacheParts } }): EnvCacheDecision {
	if (!input.enabled || !input.available) return { action: "off", restore: false, clear: false, save: false };
	const { saved, current } = input;
	if (!saved) return { action: "miss", restore: false, clear: false, save: true };
	if (saved.key === current.key) return { action: "hit", restore: true, clear: false, save: false };
	const p = saved.parts;
	if (p.install !== current.parts.install || p.runtime !== current.parts.runtime || p.env !== current.parts.env) {
		return { action: "rebuild", restore: false, clear: true, save: true };
	}
	return { action: "stale", restore: true, clear: false, save: true };
}

export function parseEnvCacheMeta(raw: string | undefined | null): EnvCacheMeta | null {
	if (!raw?.trim()) return null;
	try {
		const value = JSON.parse(raw) as Partial<EnvCacheMeta>;
		const parts = value.parts;
		if (typeof value.key !== "string" || !parts) return null;
		if (![parts.install, parts.lock, parts.runtime, parts.env].every((item) => typeof item === "string")) return null;
		return { key: value.key, parts, savedAt: typeof value.savedAt === "number" ? value.savedAt : 0 };
	} catch {
		return null;
	}
}

export type EnvCacheEntry = { name: string; usedAtMs: number; sizeBytes: number; inUse?: boolean };
export type EnvCacheEviction = { name: string; reason: "expired" | "over-limit" };

/**
 * Remove os sem uso há mais de `maxAgeMs`; depois, se o total passa de `maxBytes`,
 * remove os menos usados recentemente (LRU) até caber. Os que estão em uso são poupados.
 */
export function selectEnvCacheEvictions(entries: EnvCacheEntry[], options: { now: number; maxAgeMs: number; maxBytes: number }): EnvCacheEviction[] {
	const out: EnvCacheEviction[] = [];
	const kept: EnvCacheEntry[] = [];
	for (const entry of entries) {
		if (!entry.inUse && options.now - entry.usedAtMs > options.maxAgeMs) out.push({ name: entry.name, reason: "expired" });
		else kept.push(entry);
	}
	let total = kept.reduce((sum, entry) => sum + entry.sizeBytes, 0);
	for (const entry of [...kept].sort((a, b) => a.usedAtMs - b.usedAtMs)) {
		if (total <= options.maxBytes) break;
		if (entry.inUse) continue;
		out.push({ name: entry.name, reason: "over-limit" });
		total -= entry.sizeBytes;
	}
	return out;
}

/** Script do container auxiliar (volume montado só leitura): "<mtime do .used> <KiB>". */
export const ENV_CACHE_INSPECT_SCRIPT = `echo "$(stat -c %Y ${ENV_CACHE_MOUNT}/.used 2>/dev/null || echo 0) $(du -sk ${ENV_CACHE_MOUNT} 2>/dev/null | cut -f1)"`;

/** Esvazia o volume (inclusive arquivos ocultos), mantendo o diretório. */
export const ENV_CACHE_WIPE_SCRIPT = `find ${ENV_CACHE_MOUNT} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`;

export function parseEnvCacheInspect(output: string): { usedAtMs: number; sizeBytes: number } | null {
	const match = output.trim().split(/\s+/);
	const seconds = Number.parseInt(match[0] ?? "", 10);
	const kib = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(seconds) || !Number.isFinite(kib)) return null;
	return { usedAtMs: seconds * 1000, sizeBytes: kib * 1024 };
}
