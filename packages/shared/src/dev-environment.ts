/**
 * Ambientes de código por repositório (equivalente ao `environment.json` do
 * Cursor): comandos de instalação/inicialização, recursos, política de internet
 * e segredos. Tudo puro (validação, domínios, limites) para API, runtime e web.
 */

import { isDevApprovalMode, parseCommandAllowlist, type DevApprovalMode } from "./dev-command-approval.js";

export const DEV_ENV_TIERS = ["small", "medium", "large"] as const;
export type DevEnvTier = (typeof DEV_ENV_TIERS)[number];
export const DEV_ENV_NETWORKS = ["allowlist", "full", "off"] as const;
export type DevEnvNetwork = (typeof DEV_ENV_NETWORKS)[number];

export const DEV_ENV_COMMAND_MAX = 8_000;
export const DEV_ENV_MAX_DOMAINS = 100;
export const DEV_ENV_MAX_SECRETS = 30;
export const DEV_ENV_SECRET_VALUE_MAX = 16_384;

/** Domínios liberados por padrão no modo "Lista liberada" (mais os do usuário). */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
	"github.com",
	"*.githubusercontent.com",
	"objects.githubusercontent.com",
	"codeload.github.com",
	"registry.npmjs.org",
	"*.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"nodejs.org",
	"registry.yarnpkg.com",
	"repo.yarnpkg.com",
	"*.yarnpkg.com",
	"pypi.python.org",
];

export const DEV_ENV_TIER_LABEL: Record<DevEnvTier, string> = {
	small: "Pequeno · 1 GB",
	medium: "Médio · 2,5 GB",
	large: "Grande · 4 GB",
};

export const DEV_ENV_NETWORK_LABEL: Record<DevEnvNetwork, string> = {
	allowlist: "Lista liberada",
	full: "Acesso total",
	off: "Sem internet após preparar",
};

export function isDevEnvTier(value: unknown): value is DevEnvTier {
	return typeof value === "string" && (DEV_ENV_TIERS as readonly string[]).includes(value);
}

export function isDevEnvNetwork(value: unknown): value is DevEnvNetwork {
	return typeof value === "string" && (DEV_ENV_NETWORKS as readonly string[]).includes(value);
}

/** O menor entre dois tiers. */
export function minTier(a: DevEnvTier, b: DevEnvTier): DevEnvTier {
	return DEV_ENV_TIERS.indexOf(a) <= DEV_ENV_TIERS.indexOf(b) ? a : b;
}

/**
 * Tier efetivo da sessão. O teto é o do ambiente (se houver) limitado pelo teto
 * global; o pedido da tool só pode ficar abaixo disso, nunca acima.
 * Sem pedido: usa o do ambiente, senão o padrão (também limitado pelo teto).
 */
export function resolveSessionTier(input: {
	requested?: DevEnvTier;
	envTier?: DevEnvTier | null;
	defaultTier: DevEnvTier;
	globalMax: DevEnvTier;
}): { tier: DevEnvTier; clamped: boolean } {
	const cap = input.envTier ? minTier(input.envTier, input.globalMax) : input.globalMax;
	const wanted = input.requested ?? input.envTier ?? input.defaultTier;
	const tier = minTier(wanted, cap);
	return { tier, clamped: input.requested !== undefined && tier !== input.requested };
}

// ----- domínios -----

/** Domínio sem esquema/porta, minúsculo; `*.exemplo.com` vale para subdomínios (não para o próprio apex). */
export function normalizeDomainPattern(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/:\d+$/, "")
		.replace(/\.$/, "");
	if (!value) return null;
	const wildcard = value.startsWith("*.");
	const host = wildcard ? value.slice(2) : value;
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
	return wildcard ? `*.${host}` : host;
}

/** O mesmo critério do proxy do container (`docker/dev-sandbox/server/egress-proxy.mjs`). */
export function hostMatchesAllowlist(host: string, patterns: readonly string[]): boolean {
	const h = host.trim().toLowerCase().replace(/\.$/, "");
	if (!h) return false;
	const isIp = /^[0-9.]+$/.test(h) || h.includes(":");
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (isIp) continue;
			if (h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1) return true;
		} else if (h === pattern) {
			return true;
		}
	}
	return false;
}

/** Predefinidos + domínios do usuário, normalizados e sem repetição. */
export function buildEgressAllowlist(userDomains: readonly string[] = []): string[] {
	const out: string[] = [];
	for (const item of [...DEFAULT_EGRESS_ALLOWLIST, ...userDomains]) {
		const pattern = normalizeDomainPattern(item);
		if (pattern && !out.includes(pattern)) out.push(pattern);
	}
	return out;
}

// ----- repositório -----

/** `owner/nome` em minúsculas (o GitHub ignora caixa). Aceita URL do GitHub. */
export function normalizeEnvRepo(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let value = raw.trim();
	const url = /^https:\/\/github\.com\/(.+?)\/?$/i.exec(value);
	if (url) value = url[1]!;
	value = value.replace(/\.git$/, "");
	const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(value);
	if (!match || match[2] === "." || match[2] === "..") return null;
	return `${match[1]}/${match[2]}`.toLowerCase();
}

// ----- segredos -----

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_SECRET_NAMES = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TERM", "LANG",
	"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "NODE_OPTIONS",
	"GH_TOKEN", "GITHUB_TOKEN", "DEV_SANDBOX_TOKEN",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY",
]);

export function validateSecretName(raw: unknown): { name: string } | { error: string } {
	if (typeof raw !== "string" || !SECRET_NAME.test(raw.trim())) {
		return { error: "Nome do segredo inválido: use letras, números e sublinhado (ex.: DATABASE_URL)" };
	}
	const name = raw.trim();
	if (RESERVED_SECRET_NAMES.has(name.toUpperCase())) return { error: `O nome ${name} é reservado` };
	return { name };
}

export function validateSecretValue(raw: unknown): { value: string } | { error: string } {
	if (typeof raw !== "string" || raw.length === 0) return { error: "Informe o valor do segredo" };
	if (raw.length > DEV_ENV_SECRET_VALUE_MAX) return { error: "Valor grande demais" };
	return { value: raw };
}

/** Valores curtos demais não são redigidos da saída (evita apagar texto comum). */
export const MIN_REDACTABLE_SECRET = 4;

/** Valores do ambiente que devem ser redigidos de saídas e eventos. */
export function redactableValues(secrets: Readonly<Record<string, string>>): string[] {
	return Object.values(secrets).filter((value) => value.length >= MIN_REDACTABLE_SECRET);
}

// ----- entrada da API -----

export type DevEnvInput = {
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	testCommand: string | null;
	tier: DevEnvTier;
	network: DevEnvNetwork;
	allowlist: string[];
	/** `null` = padrão da conta. */
	approvalMode: DevApprovalMode | null;
	commandAllowlist: string[];
};

type Parsed<T> = { value: T; error?: never } | { value?: never; error: string };

function command(raw: unknown, field: string): Parsed<string | null> {
	if (raw === undefined || raw === null) return { value: null };
	if (typeof raw !== "string") return { error: `${field} inválido` };
	const text = raw.replace(/\r\n/g, "\n").trim();
	if (text.length > DEV_ENV_COMMAND_MAX) return { error: `${field} grande demais (máximo ${DEV_ENV_COMMAND_MAX} caracteres)` };
	return { value: text || null };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Domínios do usuário: lista de textos, normalizados; inválidos geram erro (a UI mostra qual). */
export function parseDomainList(raw: unknown): Parsed<string[]> {
	if (raw === undefined || raw === null) return { value: [] };
	if (!Array.isArray(raw)) return { error: "allowlist deve ser uma lista de domínios" };
	if (raw.length > DEV_ENV_MAX_DOMAINS) return { error: `No máximo ${DEV_ENV_MAX_DOMAINS} domínios` };
	const out: string[] = [];
	for (const item of raw) {
		const pattern = normalizeDomainPattern(item);
		if (!pattern) return { error: `Domínio inválido: ${typeof item === "string" ? item.slice(0, 60) : "?"}` };
		if (!out.includes(pattern)) out.push(pattern);
	}
	return { value: out };
}

/** Criação (`partial:false`, repo obrigatório) ou edição parcial (`partial:true`). */
export function parseDevEnvBody(body: unknown, options: { partial: boolean }): Parsed<Partial<DevEnvInput>> {
	if (!isObject(body)) return { error: "Corpo inválido" };
	const value: Partial<DevEnvInput> = {};
	if (!options.partial || "repo" in body) {
		const repo = normalizeEnvRepo(body.repo);
		if (!repo) return { error: "Repositório inválido: use owner/nome" };
		value.repo = repo;
	}
	if ("installCommand" in body) {
		const parsed = command(body.installCommand, "Instalação");
		if (parsed.error !== undefined) return { error: parsed.error };
		value.installCommand = parsed.value;
	}
	if ("startCommand" in body) {
		const parsed = command(body.startCommand, "Inicialização");
		if (parsed.error !== undefined) return { error: parsed.error };
		value.startCommand = parsed.value;
	}
	if ("testCommand" in body) {
		const parsed = command(body.testCommand, "Teste rápido");
		if (parsed.error !== undefined) return { error: parsed.error };
		value.testCommand = parsed.value;
	}
	if ("tier" in body) {
		if (!isDevEnvTier(body.tier)) return { error: `Recursos devem ser: ${DEV_ENV_TIERS.join(", ")}` };
		value.tier = body.tier;
	}
	if ("network" in body) {
		if (!isDevEnvNetwork(body.network)) return { error: `Internet deve ser: ${DEV_ENV_NETWORKS.join(", ")}` };
		value.network = body.network;
	}
	if ("allowlist" in body) {
		const parsed = parseDomainList(body.allowlist);
		if (parsed.error !== undefined) return { error: parsed.error };
		value.allowlist = parsed.value;
	}
	if ("approvalMode" in body) {
		if (body.approvalMode !== null && !isDevApprovalMode(body.approvalMode)) return { error: "Aprovação de comandos inválida" };
		value.approvalMode = body.approvalMode;
	}
	if ("commandAllowlist" in body) {
		const parsed = parseCommandAllowlist(body.commandAllowlist);
		if (parsed.error !== undefined) return { error: parsed.error };
		value.commandAllowlist = parsed.value;
	}
	return { value };
}
