/**
 * Catálogo público de skills e agentes (repo agent-skills). Tipos, validação e
 * utilidades PURAS (sem I/O). Todo conteúdo do catálogo é dado não confiável:
 * o que não passa aqui não é mostrado nem instalado. `tools` e
 * `suggestedConnectors` são só dicas; nunca viram permissão.
 */
import { BOT_PROPOSAL_DEFAULT_COLOR, BOT_PROPOSAL_DEFAULT_SHAPE, isBotProposalShape, resolveBotProposalColor } from "./bot-proposal.js";
import { validateSkillFields } from "./skill-markdown.js";

export const CATALOG_DEFAULT_URL = "https://raw.githubusercontent.com/ali-ali18/agent-skills/main";
/** Repo de destino dos PRs de publicação. */
export const CATALOG_REPO = "ali-ali18/agent-skills";
export const CATALOG_INDEX_MAX_BYTES = 512 * 1024;
export const CATALOG_FILE_MAX_BYTES = 64 * 1024;
export const CATALOG_MAX_ITEMS = 500;

export type CatalogChangelogEntry = { version: string; date?: string; notes: string };

export type CatalogSkillEntry = {
	slug: string;
	name: string;
	description: string;
	version: string;
	author: string;
	category: string;
	tags: string[];
	tools: string[];
	minAppVersion?: string;
	path: string;
	sha256: string;
	manifestSha256: string;
};

export type CatalogBotEntry = {
	slug: string;
	name: string;
	description: string;
	version: string;
	author: string;
	category: string;
	tags: string[];
	skills: string[];
	/** Aparência do agente como está no índice (id da cor, ex. "red", e forma); resolva com resolveBotProposalColor. */
	color: string;
	shape: string;
	path: string;
	sha256: string;
};

export type CatalogIndex = { schemaVersion: 1; skills: CatalogSkillEntry[]; bots: CatalogBotEntry[] };

export type CatalogSkillManifest = {
	slug: string;
	name: string;
	description: string;
	version: string;
	author: string;
	category: string;
	tags: string[];
	tools: string[];
	minAppVersion?: string;
	changelog: CatalogChangelogEntry[];
};

export type CatalogBotRoutine = { name: string; prompt: string; cron: string };

export type CatalogBotTemplate = {
	slug: string;
	name: string;
	description: string;
	snippet: string;
	/** Hex da paleta do app. */
	color: string;
	shape: string;
	suggestedModel: string | null;
	skills: string[];
	suggestedConnectors: { id: string; reason?: string }[];
	setupNotes: string[];
	starterRoutines: CatalogBotRoutine[];
	firstMessage: string | null;
	version: string;
	author: string;
	category: string;
	tags: string[];
	minAppVersion?: string;
	changelog: CatalogChangelogEntry[];
};

export type CatalogParse<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{64}$/;
const PATH = /^(skills|bots)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CRON = /^\S+( \S+){4}$/;
const CONNECTOR_ID = /^[a-z0-9_-]+$/;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number, min = 1): string | null {
	return typeof value === "string" && value.trim().length >= min && value.length <= max ? value.trim() : null;
}

function strList(value: unknown, max: number, itemMax: number, pattern?: RegExp): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > max) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim() || item.length > itemMax || (pattern && !pattern.test(item))) return null;
		if (!out.includes(item)) out.push(item);
	}
	return out;
}

function changelog(value: unknown): CatalogChangelogEntry[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;
	const out: CatalogChangelogEntry[] = [];
	for (const item of value) {
		if (!isObj(item)) return null;
		const version = typeof item.version === "string" && SEMVER.test(item.version) ? item.version : null;
		const notes = str(item.notes, 500);
		const date = item.date === undefined ? undefined : typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : null;
		if (!version || !notes || date === null) return null;
		out.push({ version, notes, ...(date ? { date } : {}) });
	}
	return out;
}

function common(row: Obj, errors: string[]) {
	const slug = typeof row.slug === "string" && row.slug.length <= 64 && SLUG.test(row.slug) ? row.slug : null;
	if (!slug) errors.push("slug inválido");
	const name = str(row.name, 80);
	if (!name) errors.push("name inválido");
	const version = typeof row.version === "string" && SEMVER.test(row.version) ? row.version : null;
	if (!version) errors.push("version inválida");
	const author = str(row.author, 80);
	if (!author) errors.push("author inválido");
	const category = typeof row.category === "string" && row.category.length <= 32 && SLUG.test(row.category) ? row.category : null;
	if (!category) errors.push("category inválida");
	const tags = strList(row.tags, 10, 32, SLUG);
	if (!tags) errors.push("tags inválidas");
	const minAppVersion = row.minAppVersion === undefined ? undefined : typeof row.minAppVersion === "string" && SEMVER.test(row.minAppVersion) ? row.minAppVersion : null;
	if (minAppVersion === null) errors.push("minAppVersion inválida");
	return { slug, name, version, author, category, tags, minAppVersion };
}

function entryBase(row: Obj, errors: string[]) {
	const base = common(row, errors);
	const description = str(row.description, 300);
	if (!description || /[\r\n]/.test(description)) errors.push("description inválida");
	const path = typeof row.path === "string" && PATH.test(row.path) ? row.path : null;
	if (!path) errors.push("path inválido");
	const sha256 = typeof row.sha256 === "string" && SHA.test(row.sha256) ? row.sha256 : null;
	if (!sha256) errors.push("sha256 inválido");
	return { ...base, description, path, sha256 };
}

export function parseCatalogIndex(raw: unknown): CatalogParse<CatalogIndex> {
	if (!isObj(raw) || raw.schemaVersion !== 1) return { ok: false, errors: ["Índice do catálogo em formato desconhecido."] };
	if (!Array.isArray(raw.skills) || !Array.isArray(raw.bots)) return { ok: false, errors: ["Índice do catálogo sem skills ou bots."] };
	if (raw.skills.length > CATALOG_MAX_ITEMS || raw.bots.length > CATALOG_MAX_ITEMS) return { ok: false, errors: ["Índice do catálogo grande demais."] };
	const errors: string[] = [];
	const skills: CatalogSkillEntry[] = [];
	const bots: CatalogBotEntry[] = [];
	// Item inválido é descartado (um PR ruim não derruba a lista); só vira erro se TUDO falhar.
	for (const item of raw.skills) {
		if (!isObj(item)) continue;
		const local: string[] = [];
		const base = entryBase(item, local);
		const tools = strList(item.tools, 20, 64, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
		const manifestSha256 = typeof item.manifestSha256 === "string" && SHA.test(item.manifestSha256) ? item.manifestSha256 : null;
		if (!tools || !manifestSha256) local.push("tools/manifestSha256 inválidos");
		if (local.length || !base.slug || !base.name || !base.description || !base.version || !base.author || !base.category || !base.tags || !base.path || !base.sha256 || !tools || !manifestSha256) {
			errors.push(`skill ${String(item.slug)}: ${local.join(", ")}`);
			continue;
		}
		if (base.path !== `skills/${base.slug}`) continue;
		skills.push({
			slug: base.slug,
			name: base.name,
			description: base.description,
			version: base.version,
			author: base.author,
			category: base.category,
			tags: base.tags,
			tools,
			...(base.minAppVersion ? { minAppVersion: base.minAppVersion } : {}),
			path: base.path,
			sha256: base.sha256,
			manifestSha256,
		});
	}
	for (const item of raw.bots) {
		if (!isObj(item)) continue;
		const local: string[] = [];
		const base = entryBase(item, local);
		const botSkills = strList(item.skills, 5, 64, SLUG);
		if (!botSkills) local.push("skills inválidas");
		if (local.length || !base.slug || !base.name || !base.description || !base.version || !base.author || !base.category || !base.tags || !base.path || !base.sha256 || !botSkills) {
			errors.push(`bot ${String(item.slug)}: ${local.join(", ")}`);
			continue;
		}
		if (base.path !== `bots/${base.slug}`) continue;
		bots.push({
			slug: base.slug,
			name: base.name,
			description: base.description,
			version: base.version,
			author: base.author,
			category: base.category,
			tags: base.tags,
			skills: botSkills,
			color: typeof item.color === "string" && resolveBotProposalColor(item.color) ? item.color : "orange",
			shape: isBotProposalShape(item.shape) ? item.shape.trim() : BOT_PROPOSAL_DEFAULT_SHAPE,
			path: base.path,
			sha256: base.sha256,
		});
	}
	if (skills.length === 0 && bots.length === 0 && errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { schemaVersion: 1, skills, bots } };
}

export function parseSkillManifest(raw: unknown): CatalogParse<CatalogSkillManifest> {
	if (!isObj(raw)) return { ok: false, errors: ["manifest.json inválido."] };
	const errors: string[] = [];
	const base = common(raw, errors);
	const description = str(raw.description, 300);
	if (!description || /[\r\n]/.test(description)) errors.push("description inválida");
	const tools = strList(raw.tools, 20, 64, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
	if (!tools) errors.push("tools inválidas");
	const log = changelog(raw.changelog);
	if (!log) errors.push("changelog inválido");
	if (errors.length || !base.slug || !base.name || !base.version || !base.author || !base.category || !base.tags || !description || !tools || !log) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		value: {
			slug: base.slug,
			name: base.name,
			description,
			version: base.version,
			author: base.author,
			category: base.category,
			tags: base.tags,
			tools,
			...(base.minAppVersion ? { minAppVersion: base.minAppVersion } : {}),
			changelog: log,
		},
	};
}

/** Valida `bot.json` (modelo de agente). Cor/forma desconhecidas caem no padrão do app. */
export function parseBotTemplate(raw: unknown): CatalogParse<CatalogBotTemplate> {
	if (!isObj(raw)) return { ok: false, errors: ["bot.json inválido."] };
	const errors: string[] = [];
	const base = common(raw, errors);
	const name = str(raw.name, 40);
	if (!name) errors.push("name deve ter até 40 caracteres");
	const description = str(raw.description, 600);
	if (!description) errors.push("description deve ter até 600 caracteres");
	const snippet = str(raw.snippet, 90);
	if (!snippet) errors.push("snippet deve ter até 90 caracteres");
	const appearance = isObj(raw.appearance) ? raw.appearance : {};
	const color = resolveBotProposalColor(appearance.color) ?? BOT_PROPOSAL_DEFAULT_COLOR;
	const shape = isBotProposalShape(appearance.shape) ? appearance.shape.trim() : BOT_PROPOSAL_DEFAULT_SHAPE;
	const suggestedModel = raw.suggestedModel === undefined || raw.suggestedModel === null ? null : str(raw.suggestedModel, 120);
	if (raw.suggestedModel !== undefined && raw.suggestedModel !== null && !suggestedModel) errors.push("suggestedModel inválido");
	const skills = strList(raw.skills, 5, 64, SLUG);
	if (!skills) errors.push("skills inválidas");

	const connectors: { id: string; reason?: string }[] = [];
	if (raw.suggestedConnectors !== undefined) {
		if (!Array.isArray(raw.suggestedConnectors) || raw.suggestedConnectors.length > 10) errors.push("suggestedConnectors inválido");
		else {
			for (const item of raw.suggestedConnectors) {
				const id = isObj(item) && typeof item.id === "string" && item.id.length <= 40 && CONNECTOR_ID.test(item.id) ? item.id : null;
				const reason = isObj(item) && typeof item.reason === "string" ? item.reason.trim().slice(0, 200) : undefined;
				if (!id) errors.push("suggestedConnectors com id inválido");
				else connectors.push({ id, ...(reason ? { reason } : {}) });
			}
		}
	}
	const setupNotes = strList(raw.setupNotes, 10, 300);
	if (!setupNotes) errors.push("setupNotes inválido");

	const routines: CatalogBotRoutine[] = [];
	if (raw.starterRoutines !== undefined) {
		if (!Array.isArray(raw.starterRoutines) || raw.starterRoutines.length > 5) errors.push("starterRoutines inválido");
		else {
			for (const item of raw.starterRoutines) {
				const rname = isObj(item) ? str(item.name, 80) : null;
				const prompt = isObj(item) ? str(item.prompt, 2000) : null;
				const cron = isObj(item) && typeof item.cron === "string" && CRON.test(item.cron.trim()) ? item.cron.trim() : null;
				if (!rname || !prompt || !cron) errors.push("starterRoutines com item inválido");
				else routines.push({ name: rname, prompt, cron });
			}
		}
	}
	const firstMessage = raw.firstMessage === undefined ? null : str(raw.firstMessage, 2000);
	if (raw.firstMessage !== undefined && !firstMessage) errors.push("firstMessage inválida");
	const log = changelog(raw.changelog);
	if (!log) errors.push("changelog inválido");

	if (errors.length || !base.slug || !base.version || !base.author || !base.category || !base.tags || !name || !description || !snippet || !skills || !setupNotes || !log) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		value: {
			slug: base.slug,
			name,
			description,
			snippet,
			color,
			shape,
			suggestedModel,
			skills,
			suggestedConnectors: connectors,
			setupNotes,
			starterRoutines: routines,
			firstMessage,
			version: base.version,
			author: base.author,
			category: base.category,
			tags: base.tags,
			...(base.minAppVersion ? { minAppVersion: base.minAppVersion } : {}),
			changelog: log,
		},
	};
}

/** `1.2.3` -> [1,2,3]; inválido = null. */
function semver(version: string): [number, number, number] | null {
	const match = SEMVER.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** >0 se `a` é mais novo que `b`; versão inválida conta como 0.0.0. */
export function compareSemver(a: string, b: string): number {
	const x = semver(a) ?? [0, 0, 0];
	const y = semver(b) ?? [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const delta = (x[i] as number) - (y[i] as number);
		if (delta !== 0) return delta;
	}
	return 0;
}

export function isNewerVersion(candidate: string, installed: string): boolean {
	return compareSemver(candidate, installed) > 0;
}

export type TextDiff = {
	added: number;
	removed: number;
	/** Até 12 linhas com prefixo "+ " / "- ". */
	preview: string[];
	identical: boolean;
};

const DIFF_MAX_LINES = 1500;

/** Diferença por linhas (LCS) entre dois textos; resumo para o usuário decidir. */
export function summarizeTextDiff(before: string, after: string): TextDiff {
	const a = before.replace(/\r\n?/g, "\n").trim().split("\n").slice(0, DIFF_MAX_LINES);
	const b = after.replace(/\r\n?/g, "\n").trim().split("\n").slice(0, DIFF_MAX_LINES);
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Uint16Array(rows * cols);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * cols + j] =
				a[i] === b[j] ? (table[(i + 1) * cols + j + 1] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
		}
	}
	const preview: string[] = [];
	let added = 0;
	let removed = 0;
	let i = 0;
	let j = 0;
	const note = (line: string) => {
		if (preview.length < 12) preview.push(line.length > 140 ? `${line.slice(0, 137)}...` : line);
	};
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (j < b.length && (i === a.length || (table[i * cols + j + 1] as number) >= (table[(i + 1) * cols + j] as number))) {
			added++;
			if ((b[j] as string).trim()) note(`+ ${b[j]}`);
			j++;
		} else {
			removed++;
			if ((a[i] as string).trim()) note(`- ${a[i]}`);
			i++;
		}
	}
	return { added, removed, preview, identical: added === 0 && removed === 0 };
}

/** Arquivos que o PR de publicação leva ao catálogo (conteúdo já normalizado). */
export type CatalogPublishInput = {
	name: string;
	description: string;
	body: string;
	tools: string[];
	author: string;
	version: string;
	category: string;
	tags: string[];
	notes: string;
	/** Changelog anterior (atualização de item existente). */
	previousChangelog?: CatalogChangelogEntry[];
	date: string;
};

export function validateCatalogPublishInput(input: CatalogPublishInput): string[] {
	const errors: string[] = [];
	const parsed = validateSkillFields({ name: input.name, description: input.description, body: input.body, tools: input.tools });
	if (!parsed.ok) errors.push(...parsed.errors);
	if (!SEMVER.test(input.version)) errors.push("A versão deve ser no formato 1.0.0.");
	if (!SLUG.test(input.category) || input.category.length > 32) errors.push("A categoria deve ser um slug de até 32 caracteres.");
	if (input.tags.length > 10 || input.tags.some((tag) => !SLUG.test(tag) || tag.length > 32)) errors.push("Tags inválidas (até 10, em formato slug).");
	if (!input.author.trim() || input.author.length > 80) errors.push("Informe o autor.");
	if (!input.notes.trim() || input.notes.length > 500) errors.push("Descreva a mudança em até 500 caracteres.");
	return errors;
}

export function buildCatalogManifest(input: CatalogPublishInput): CatalogSkillManifest {
	const entry: CatalogChangelogEntry = { version: input.version, date: input.date, notes: input.notes.trim() };
	const previous = (input.previousChangelog ?? []).filter((item) => item.version !== input.version);
	return {
		slug: input.name,
		name: input.name,
		description: input.description.trim(),
		version: input.version,
		author: input.author.trim(),
		category: input.category,
		tags: input.tags,
		tools: input.tools,
		changelog: [entry, ...previous].slice(0, 50),
	};
}

/** Origem de uma skill instalada do catálogo (gravada com a skill). */
export type SkillSource = { kind: "catalog"; slug: string; version: string; hash: string };

/** O que a API devolve ao web: sem o hash; `edited` = o conteúdo atual difere do instalado. */
export type SkillProvenance = { kind: "catalog"; slug: string; version: string; edited: boolean };
