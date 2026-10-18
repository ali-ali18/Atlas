import { createHash } from "node:crypto";
import { safeHttpRequest } from "@workspace/agent-runtime";
import {
	CATALOG_DEFAULT_URL,
	CATALOG_FILE_MAX_BYTES,
	CATALOG_INDEX_MAX_BYTES,
	hasBlockingFinding,
	parseBotTemplate,
	parseCatalogIndex,
	parseSkillManifest,
	parseSkillMarkdown,
	scanSuspiciousInstructions,
	type CatalogBotEntry,
	type CatalogBotTemplate,
	type CatalogIndex,
	type CatalogSkillEntry,
	type CatalogSkillManifest,
	type ScanFinding,
	type SkillMarkdown,
} from "@workspace/shared";

/**
 * Leitor do catálogo (repo agent-skills). Tudo que vem de lá é dado não
 * confiável: busca só por https com o guard SSRF do projeto, teto de bytes,
 * hash conferido contra o índice, schema validado e varredura de instruções
 * suspeitas. Cache em memória (~10 min) com "serve o antigo se a rede falhar".
 */

export const CATALOG_CACHE_TTL_MS = 10 * 60_000;

export class CatalogError extends Error {
	constructor(
		readonly kind: "unavailable" | "invalid" | "not_found" | "integrity",
		message: string,
	) {
		super(message);
		this.name = "CatalogError";
	}
}

type SafeHttpOptions = NonNullable<Parameters<typeof safeHttpRequest>[1]>;
export type CatalogHttp = (url: string, options?: SafeHttpOptions) => Promise<{ status: number; text: string; truncated: boolean }>;

export type CatalogSkillContent = {
	entry: CatalogSkillEntry;
	manifest: CatalogSkillManifest;
	skill: SkillMarkdown;
	/** SKILL.md inteiro (como está no catálogo). */
	markdown: string;
	findings: ScanFinding[];
};

export type CatalogBotContent = {
	entry: CatalogBotEntry;
	bot: CatalogBotTemplate;
	findings: ScanFinding[];
};

export type CatalogClientDeps = {
	http?: CatalogHttp;
	now?: () => number;
	baseUrl?: () => string;
};

export function catalogBaseUrl(): string {
	const raw = process.env.SKILLS_CATALOG_URL?.trim();
	return (raw || CATALOG_DEFAULT_URL).replace(/\/+$/, "");
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Texto de todos os campos livres do bot, para a varredura. */
function botText(bot: CatalogBotTemplate): string {
	return [
		bot.name,
		bot.description,
		bot.snippet,
		bot.firstMessage ?? "",
		...bot.setupNotes,
		...bot.starterRoutines.flatMap((routine) => [routine.name, routine.prompt]),
		...bot.suggestedConnectors.map((connector) => connector.reason ?? ""),
	].join("\n");
}

export function createCatalogClient(deps: CatalogClientDeps = {}) {
	const http: CatalogHttp =
		deps.http ?? ((url, options) => safeHttpRequest(url, { timeoutMs: 10_000, maxRedirects: 3, ...options }));
	const now = deps.now ?? Date.now;
	const base = deps.baseUrl ?? catalogBaseUrl;
	const cache = new Map<string, { at: number; text: string }>();

	async function fetchText(path: string, maxBytes: number): Promise<string> {
		const url = `${base()}/${path}`;
		const hit = cache.get(url);
		if (hit && now() - hit.at < CATALOG_CACHE_TTL_MS) return hit.text;
		try {
			const response = await http(url, { method: "GET", maxBytes, headers: { Accept: "application/json, text/plain" } });
			if (response.status === 404) throw new CatalogError("not_found", "Item não encontrado no catálogo.");
			if (response.status !== 200) throw new CatalogError("unavailable", "O catálogo não respondeu agora.");
			if (response.truncated) throw new CatalogError("invalid", "Arquivo grande demais no catálogo.");
			cache.set(url, { at: now(), text: response.text });
			return response.text;
		} catch (error) {
			if (error instanceof CatalogError && error.kind !== "unavailable") throw error;
			if (hit) return hit.text;
			throw error instanceof CatalogError ? error : new CatalogError("unavailable", "Não foi possível acessar o catálogo.");
		}
	}

	async function index(): Promise<CatalogIndex> {
		const text = await fetchText("index.json", CATALOG_INDEX_MAX_BYTES);
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new CatalogError("invalid", "Índice do catálogo inválido.");
		}
		const parsed = parseCatalogIndex(raw);
		if (!parsed.ok) throw new CatalogError("invalid", "Índice do catálogo inválido.");
		return parsed.value;
	}

	async function skill(slug: string): Promise<CatalogSkillContent> {
		const entry = (await index()).skills.find((item) => item.slug === slug);
		if (!entry) throw new CatalogError("not_found", "Habilidade não encontrada no catálogo.");
		const [markdown, manifestText] = await Promise.all([
			fetchText(`${entry.path}/SKILL.md`, CATALOG_FILE_MAX_BYTES),
			fetchText(`${entry.path}/manifest.json`, CATALOG_FILE_MAX_BYTES),
		]);
		if (sha256(markdown) !== entry.sha256 || sha256(manifestText) !== entry.manifestSha256) {
			throw new CatalogError("integrity", "O conteúdo da habilidade não confere com o índice. Tente de novo em alguns minutos.");
		}
		let manifestRaw: unknown;
		try {
			manifestRaw = JSON.parse(manifestText);
		} catch {
			throw new CatalogError("invalid", "manifest.json inválido.");
		}
		const manifest = parseSkillManifest(manifestRaw);
		if (!manifest.ok) throw new CatalogError("invalid", "manifest.json inválido.");
		const parsed = parseSkillMarkdown(markdown);
		if (!parsed.ok) throw new CatalogError("invalid", "SKILL.md inválido.");
		if (manifest.value.slug !== slug || parsed.skill.name !== slug || manifest.value.version !== entry.version) {
			throw new CatalogError("invalid", "A habilidade não bate com o manifest.");
		}
		return { entry, manifest: manifest.value, skill: parsed.skill, markdown, findings: scanSuspiciousInstructions(markdown) };
	}

	async function bot(slug: string): Promise<CatalogBotContent> {
		const idx = await index();
		const entry = idx.bots.find((item) => item.slug === slug);
		if (!entry) throw new CatalogError("not_found", "Agente não encontrado no catálogo.");
		const text = await fetchText(`${entry.path}/bot.json`, CATALOG_FILE_MAX_BYTES);
		if (sha256(text) !== entry.sha256) {
			throw new CatalogError("integrity", "O conteúdo do agente não confere com o índice. Tente de novo em alguns minutos.");
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new CatalogError("invalid", "bot.json inválido.");
		}
		const parsed = parseBotTemplate(raw);
		if (!parsed.ok) throw new CatalogError("invalid", "bot.json inválido.");
		if (parsed.value.slug !== slug || parsed.value.version !== entry.version) throw new CatalogError("invalid", "O agente não bate com o índice.");
		const known = new Set(idx.skills.map((item) => item.slug));
		if (parsed.value.skills.some((item) => !known.has(item))) throw new CatalogError("invalid", "O agente usa uma habilidade que não está no catálogo.");
		return { entry, bot: parsed.value, findings: scanSuspiciousInstructions(botText(parsed.value)) };
	}

	return { index, skill, bot, clearCache: () => cache.clear() };
}

export type CatalogClient = ReturnType<typeof createCatalogClient>;
export { hasBlockingFinding };
