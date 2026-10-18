/**
 * Ambientes automáticos (zero configuração): leitura local do repositório clonado,
 * atualização pelo agente com limites, pedido de segredos e dicas de falha
 * (variável ausente, falta de memória). Tudo puro, sem regex.
 */

import { DEV_COMMAND_ALLOWLIST_MAX, agentMayAllowPrefix, normalizeCommandPrefix } from "./dev-command-approval.js";
import { DETECT_TEXT_FILES, type RepoProbe } from "./dev-env-detect.js";
import { isValidSecretName } from "./vault.js";
import { DEV_ENV_COMMAND_MAX, DEV_ENV_TIER_LABEL, DEV_ENV_TIERS, isDevEnvTier, minTier, validateSecretName, type DevEnvTier } from "./dev-environment.js";

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// ----- leitura local (dentro do container) -----

const ROOT_MARK = "::ROOT::";
const FILE_MARK = "::FILE:";
const MARK_END = "::";

/** Script do container: lista a raiz e imprime os arquivos de texto conhecidos (sem token, sem rede). */
export const LOCAL_PROBE_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 1',
	`echo "${ROOT_MARK}"`,
	"ls -1A | head -300",
	`for f in ${DETECT_TEXT_FILES.map((name) => `"${name}"`).join(" ")}; do`,
	'  if [ -f "$f" ] && [ "$(wc -c < "$f")" -lt 200000 ]; then',
	`    echo "${FILE_MARK}$f${MARK_END}"`,
	'    cat "$f"',
	"    echo",
	"  fi",
	"done",
].join(NL);

/** Saída do `LOCAL_PROBE_SCRIPT` → entrada da detecção. */
export function parseLocalProbeOutput(output: string): RepoProbe {
	const rootFiles: string[] = [];
	const texts: Record<string, string> = {};
	let mode: "none" | "root" | "file" = "none";
	let current = "";
	let buffer: string[] = [];
	const flush = () => {
		if (mode === "file" && current) texts[current] = buffer.join(NL).trimEnd();
		buffer = [];
	};
	for (const raw of output.split(NL)) {
		const line = raw.endsWith(CR) ? raw.slice(0, -1) : raw;
		if (line === ROOT_MARK) {
			flush();
			mode = "root";
			continue;
		}
		if (line.startsWith(FILE_MARK) && line.endsWith(MARK_END)) {
			flush();
			mode = "file";
			current = line.slice(FILE_MARK.length, line.length - MARK_END.length);
			continue;
		}
		if (mode === "root") {
			if (line.trim()) rootFiles.push(line.trim());
		} else if (mode === "file") buffer.push(line);
	}
	flush();
	return { rootFiles, texts };
}

// ----- atualização do ambiente pelo agente -----

export type EnvUpdateRequest = {
	installCommand?: string;
	startCommand?: string;
	testCommand?: string;
	/** Prefixos a acrescentar à lista liberada. */
	commandAllowlistAdd?: string[];
	tier?: DevEnvTier;
};

export type EnvUpdateCurrent = {
	installCommand: string | null;
	startCommand: string | null;
	testCommand?: string | null;
	tier: DevEnvTier;
	commandAllowlist: string[];
	userEditedFields: readonly string[];
};

export type EnvUpdatePlan = {
	/** Campos a gravar (só os aplicados). */
	patch: { installCommand?: string; startCommand?: string; testCommand?: string; commandAllowlist?: string[]; tier?: DevEnvTier };
	applied: string[];
	skipped: string[];
	tierChange?: { from: DevEnvTier; to: DevEnvTier };
};

/** Quais campos o agente pode pedir (rede e segredos nunca). */
export const ENV_UPDATE_FIELDS = ["installCommand", "startCommand", "testCommand", "commandAllowlistAdd", "tier"] as const;

export function parseEnvUpdateArgs(args: Record<string, unknown>): { value: EnvUpdateRequest } | { error: string } {
	const value: EnvUpdateRequest = {};
	for (const key of ["installCommand", "startCommand", "testCommand"] as const) {
		const raw = args[key];
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== "string" || !raw.trim()) return { error: `${key} deve ser um texto não vazio` };
		if (raw.length > DEV_ENV_COMMAND_MAX) return { error: `${key} grande demais` };
		value[key] = raw.trim();
	}
	const add = args.commandAllowlistAdd ?? args.testCommands;
	if (add !== undefined && add !== null) {
		if (!Array.isArray(add) || add.some((item) => typeof item !== "string")) return { error: "commandAllowlistAdd deve ser uma lista de comandos" };
		value.commandAllowlistAdd = add as string[];
	}
	if (args.tier !== undefined && args.tier !== null) {
		if (!isDevEnvTier(args.tier)) return { error: `tier deve ser um de: ${DEV_ENV_TIERS.join(", ")}` };
		value.tier = args.tier;
	}
	if (Object.keys(value).length === 0) return { error: "Informe ao menos um campo: installCommand, startCommand, testCommand, commandAllowlistAdd ou tier" };
	return { value };
}

/** Aplica o pedido do agente respeitando o que o usuário editou e o teto de recursos do servidor. */
export function planEnvironmentUpdate(current: EnvUpdateCurrent, request: EnvUpdateRequest, limits: { maxTier: DevEnvTier }): EnvUpdatePlan {
	const plan: EnvUpdatePlan = { patch: {}, applied: [], skipped: [] };
	const edited = new Set(current.userEditedFields);
	const skip = (field: string, why: string) => plan.skipped.push(`${field} (${why})`);
	for (const field of ["installCommand", "startCommand", "testCommand"] as const) {
		const next = request[field];
		if (next === undefined) continue;
		if (edited.has(field)) skip(field, "editado pelo usuário");
		else if (next !== (current[field] ?? null)) {
			plan.patch[field] = next;
			plan.applied.push(field);
		}
	}
	if (request.commandAllowlistAdd) {
		if (edited.has("commandAllowlist")) skip("commandAllowlist", "editada pelo usuário");
		else {
			const list = [...current.commandAllowlist];
			const added: string[] = [];
			for (const raw of request.commandAllowlistAdd) {
				const prefix = normalizeCommandPrefix(raw);
				if (!prefix) {
					skip(`comando "${String(raw).slice(0, 40)}"`, "não permitido como prefixo liberado");
					continue;
				}
				if (!agentMayAllowPrefix(prefix)) {
					skip(`comando "${prefix.slice(0, 40)}"`, "só o usuário libera comandos que saem do ambiente ou não têm volta");
					continue;
				}
				if (!list.includes(prefix) && list.length < DEV_COMMAND_ALLOWLIST_MAX) {
					list.push(prefix);
					added.push(prefix);
				}
			}
			if (added.length) {
				plan.patch.commandAllowlist = list;
				plan.applied.push(`commandAllowlist +${added.join(", ")}`);
			}
		}
	}
	if (request.tier) {
		if (edited.has("tier")) skip("tier", "editado pelo usuário");
		else {
			const to = minTier(request.tier, limits.maxTier);
			if (to !== request.tier) skip("tier", `acima do teto do servidor (${DEV_ENV_TIER_LABEL[limits.maxTier]})`);
			if (to !== current.tier) {
				plan.patch.tier = to;
				plan.tierChange = { from: current.tier, to };
				plan.applied.push("tier");
			}
		}
	}
	return plan;
}

export function describeEnvUpdate(plan: EnvUpdatePlan): string {
	const lines: string[] = [];
	if (plan.applied.length) lines.push(`Ambiente atualizado: ${plan.applied.join("; ")}.`);
	else lines.push("Nada mudou no ambiente.");
	if (plan.skipped.length) lines.push(`Não alterado: ${plan.skipped.join("; ")}.`);
	if (plan.tierChange) lines.push(`Recursos aumentados para ${DEV_ENV_TIER_LABEL[plan.tierChange.to]}.`);
	return lines.join(" ");
}

export function tierChangeNote(to: DevEnvTier): string {
	const label = DEV_ENV_TIER_LABEL[to];
	return `Recursos aumentados para ${label.split(" · ")[0]}`;
}

// ----- pedido de segredos -----

export const REQUEST_SECRETS_MAX_NAMES = 20;
/** `environmentId` do pedido de segredo que vai para o Cofre do usuário (não para um ambiente de código). */
export const VAULT_ENVIRONMENT_ID = "vault";

export function parseRequestSecretsArgs(args: Record<string, unknown>): { names: string[]; reason: string } | { error: string } {
	const raw = args.names;
	if (!Array.isArray(raw) || raw.length === 0) return { error: "names deve ser uma lista com ao menos um nome de variável (ex.: DATABASE_URL)" };
	if (raw.length > REQUEST_SECRETS_MAX_NAMES) return { error: `No máximo ${REQUEST_SECRETS_MAX_NAMES} nomes por pedido` };
	const names: string[] = [];
	for (const item of raw) {
		const checked = validateSecretName(item);
		if ("error" in checked) return { error: checked.error };
		if (!names.includes(checked.name)) names.push(checked.name);
	}
	const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 300) : "";
	if (!reason) return { error: "Informe reason: por que o projeto precisa dessas variáveis" };
	return { names, reason };
}

/** Texto do cartão: "Este projeto precisa de: A, B — motivo". */
export function secretsRequestTitle(names: readonly string[]): string {
	return `Este projeto precisa de: ${names.join(", ")}`;
}

/** Conteúdo inicial do textarea do cartão: `NOME=` por linha. */
export function secretsRequestTemplate(names: readonly string[]): string {
	return names.map((name) => `${name}=`).join(NL);
}

// ----- dicas na saída dos comandos -----

const MISSING_TRIGGERS = [
	"missing environment variable",
	"environment variable",
	"env var",
	"is not defined",
	"is not set",
	"is required",
	"must be set",
	"not set",
	"missing required",
	"dotenv",
	".env",
	"undefined",
];
const NOT_SECRET_NAMES = new Set(["NODE_ENV", "PATH", "HOME", "ERROR", "WARN", "WARNING", "FATAL", "TRUE", "FALSE", "NULL", "NONE", "UNDEFINED", "CI", "TTY", "PWD", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "DEBUG"]);

function isUpperName(token: string): boolean {
	if (token.length < 3 || token.length > 64) return false;
	const first = token.charCodeAt(0);
	if (first < 65 || first > 90) return false;
	let underscore = false;
	for (let i = 0; i < token.length; i++) {
		const code = token.charCodeAt(i);
		if (code === 95) underscore = true;
		else if (!((code >= 65 && code <= 90) || (code >= 48 && code <= 57))) return false;
	}
	return underscore || token.length >= 6;
}

function tokensOf(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i <= line.length; i++) {
		const ch = i < line.length ? line[i]! : " ";
		const code = ch.charCodeAt(0);
		const word = ch === "_" || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		if (word) cur += ch;
		else if (cur) {
			out.push(cur);
			cur = "";
		}
	}
	return out;
}

/** Nomes de variáveis de ambiente que a saída do comando diz estarem faltando (até 8). */
export function detectMissingEnvVars(output: string): string[] {
	const found: string[] = [];
	const lines = output.split(NL).slice(-400);
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!MISSING_TRIGGERS.some((trigger) => lower.includes(trigger))) continue;
		const missingish = ["missing", "not defined", "not set", "is required", "must be set", "undefined", "not found", "dotenv", "invalid environment", "required"].some((word) => lower.includes(word));
		if (!missingish) continue;
		for (const token of tokensOf(line)) {
			if (isUpperName(token) && !NOT_SECRET_NAMES.has(token) && !found.includes(token) && validateSecretNameOk(token)) found.push(token);
			if (found.length >= 8) return found;
		}
	}
	return found;
}

function validateSecretNameOk(name: string): boolean {
	return !("error" in validateSecretName(name));
}

export function missingEnvHint(names: readonly string[]): string {
	return `Parece faltar variável de ambiente: ${names.join(", ")}. Se for um segredo do projeto (banco, chave de API), chame request_secrets com esses nomes e o motivo; depois rode o comando de novo. Nunca invente valores.`;
}

/** 137 = SIGKILL (no container, quase sempre OOM). */
export function memoryKillHint(input: { exitCode: number | null; output: string; killedByTool?: boolean; tier: DevEnvTier; maxTier: DevEnvTier }): string | null {
	const lower = input.output.toLowerCase();
	const oomText = lower.includes("out of memory") || lower.includes("oomkilled") || lower.includes("heap out of memory") || lower.includes("cannot allocate memory");
	if (input.killedByTool) return null;
	if (input.exitCode !== 137 && !oomText) return null;
	const order = DEV_ENV_TIERS;
	const nextIndex = order.indexOf(input.tier) + 1;
	const next = nextIndex < order.length ? order[nextIndex]! : null;
	const base = `O comando foi encerrado por falta de memória (exit ${input.exitCode ?? "137"} / OOM; recursos atuais: ${DEV_ENV_TIER_LABEL[input.tier]}).`;
	if (!next || order.indexOf(next) > order.indexOf(input.maxTier)) return `${base} Já está no teto de recursos do servidor: reduza o paralelismo (ex.: --maxWorkers=2, NODE_OPTIONS só se não for reservado) ou rode partes menores.`;
	return `${base} Aumente um nível com dev_environment_update {tier: "${next}"}; a sessão reinicia com mais memória (workspace mantido) e o painel mostra "Recursos aumentados".`;
}

/** Dados do cartão de pedido de segredos (só nomes e motivo; valores nunca passam pelo agente). */
export type SecretsRequestInfo = {
	environmentId: string;
	repo: string;
	names: string[];
	reason: string;
};

export function parseSecretsRequestInfo(raw: unknown): SecretsRequestInfo | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const row = raw as Record<string, unknown>;
	if (typeof row.environmentId !== "string" || !row.environmentId || typeof row.repo !== "string" || !Array.isArray(row.names)) return undefined;
	const names: string[] = [];
	const vault = row.environmentId === VAULT_ENVIRONMENT_ID;
	for (const item of row.names.slice(0, REQUEST_SECRETS_MAX_NAMES)) {
		const checked = vault ? (isValidSecretName(item) ? { name: item } : { error: "nome inválido" }) : validateSecretName(item);
		if (!("error" in checked) && !names.includes(checked.name)) names.push(checked.name);
	}
	if (names.length === 0) return undefined;
	return { environmentId: row.environmentId.slice(0, 64), repo: row.repo.slice(0, 140), names, reason: typeof row.reason === "string" ? row.reason.slice(0, 300) : "" };
}
