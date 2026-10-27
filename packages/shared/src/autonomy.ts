/**
 * Autonomia do agente (F10): quando ele age sozinho e quando pergunta.
 *
 * Tudo puro (sem I/O, relógio injetado). Três classes de ação
 * (`read` | `write` | `irreversible`), três níveis e exceções por conector ou
 * tool. `decideAction` é o gate único usado pelo runtime.
 */

export const AUTONOMY_LEVELS = ["autonomous", "balanced", "always_ask"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_EXCEPTION_MODES = ["always_ask", "never_ask", "blocked"] as const;
export type AutonomyExceptionMode = (typeof AUTONOMY_EXCEPTION_MODES)[number];

export type ActionClass = "read" | "write" | "irreversible";
export type AutonomyDecision = "allow" | "ask" | "block";

/** Exceção: `connector` (catalogId ou slug) ou `tool` (nome exposto). A tool vence o conector. */
export type AutonomyException = {
	connector?: string;
	tool?: string;
	mode: AutonomyExceptionMode;
};

/**
 * Política guardada. `level` ausente = herda (só faz sentido no bot; na conta
 * vale `balanced`). `until` vencido cai para `fallbackLevel`.
 */
export type AutonomyPolicy = {
	level?: AutonomyLevel;
	until?: string;
	fallbackLevel?: AutonomyLevel;
	exceptions: AutonomyException[];
};

export type EffectiveAutonomy = AutonomyPolicy & { level: AutonomyLevel };

export type AutonomyToolMeta = {
	actionClass: ActionClass;
	/** Nome exposto ao modelo (`mcp__<slug>__<tool>`, `propose_profile_update`…). */
	tool: string;
	/** Chaves do conector que casam com `exception.connector` (catalogId e slug). */
	connectors?: readonly string[];
	/** Tool do próprio agente (perfil, skill) em vez de conector. */
	host?: boolean;
};

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "balanced";
export const AUTONOMY_MAX_EXCEPTIONS = 100;
const AUTONOMY_KEY_MAX_CHARS = 120;

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
	autonomous: "Autônomo",
	balanced: "Equilibrado",
	always_ask: "Sempre perguntar",
};

export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
	autonomous: "Age sozinho. Só pergunta antes de apagar, enviar ou algo que não dá para desfazer.",
	balanced: "Age sozinho no seu perfil e nas leituras. Pergunta antes de alterar dados nos conectores.",
	always_ask: "Pergunta antes de qualquer alteração, em conectores ou no próprio agente.",
};

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function isExceptionMode(value: unknown): value is AutonomyExceptionMode {
	return typeof value === "string" && (AUTONOMY_EXCEPTION_MODES as readonly string[]).includes(value);
}

function cleanKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > AUTONOMY_KEY_MAX_CHARS) return undefined;
	return trimmed;
}

function validIso(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Valida o JSON guardado (`autonomyJson`). Tolerante: campo inválido é
 * descartado, exceção inválida é ignorada. `null` quando não é um objeto.
 */
export function parseAutonomyPolicy(raw: unknown): AutonomyPolicy | null {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const policy: AutonomyPolicy = { exceptions: [] };
	if (isAutonomyLevel(record.level)) policy.level = record.level;
	const until = validIso(record.until);
	if (until) policy.until = until;
	if (isAutonomyLevel(record.fallbackLevel)) policy.fallbackLevel = record.fallbackLevel;
	if (Array.isArray(record.exceptions)) {
		for (const item of record.exceptions) {
			if (policy.exceptions.length >= AUTONOMY_MAX_EXCEPTIONS) break;
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const entry = item as Record<string, unknown>;
			if (!isExceptionMode(entry.mode)) continue;
			const connector = cleanKey(entry.connector);
			const tool = cleanKey(entry.tool);
			if (!connector && !tool) continue;
			policy.exceptions.push({
				...(tool ? { tool } : { connector }),
				mode: entry.mode,
			});
		}
	}
	return policy;
}

export type AutonomyExpiry = {
	scope: "bot" | "account";
	/** Nível que estava valendo antes de vencer. */
	from: AutonomyLevel;
	/** Nível efetivo depois do vencimento. */
	to: AutonomyLevel;
	/** O que gravar no lugar (`null` = limpar; só no bot). */
	next: AutonomyPolicy | null;
	/** O que estava gravado (para gravar só se ninguém mudou antes: compare-and-set). */
	previous: AutonomyPolicy;
};

export type ResolvedAutonomy = {
	policy: EffectiveAutonomy;
	source: "bot" | "account" | "default";
	expired: AutonomyExpiry[];
};

function isExpired(policy: AutonomyPolicy, now: Date): boolean {
	if (!policy.until) return false;
	return Date.parse(policy.until) <= now.getTime();
}

function afterExpiry(policy: AutonomyPolicy): AutonomyPolicy {
	const { until: _until, fallbackLevel, level: _level, ...rest } = policy;
	return { ...rest, ...(fallbackLevel ? { level: fallbackLevel } : {}) };
}

function isEmptyPolicy(policy: AutonomyPolicy): boolean {
	return !policy.level && policy.exceptions.length === 0;
}

/**
 * Política efetiva: bot válido > conta > `balanced`. Política vencida cai para
 * o `fallbackLevel` (sem ele: o bot herda; a conta volta ao padrão). As
 * exceções dos dois escopos valem juntas (as do bot têm prioridade).
 */
export function resolveAutonomy(input: {
	bot?: unknown;
	account?: unknown;
	now: Date;
}): ResolvedAutonomy {
	const expired: AutonomyExpiry[] = [];
	let account = parseAutonomyPolicy(input.account);
	let bot = parseAutonomyPolicy(input.bot);

	if (account && isExpired(account, input.now)) {
		const next = afterExpiry(account);
		expired.push({
			scope: "account",
			from: account.level ?? DEFAULT_AUTONOMY_LEVEL,
			to: next.level ?? DEFAULT_AUTONOMY_LEVEL,
			next: isEmptyPolicy(next) ? null : next,
			previous: account,
		});
		account = next;
	}
	const accountLevel = account?.level ?? DEFAULT_AUTONOMY_LEVEL;

	if (bot && isExpired(bot, input.now)) {
		const next = afterExpiry(bot);
		expired.push({
			scope: "bot",
			from: bot.level ?? accountLevel,
			to: next.level ?? accountLevel,
			next: isEmptyPolicy(next) ? null : next,
			previous: bot,
		});
		bot = next;
	}

	const level = bot?.level ?? accountLevel;
	const source: ResolvedAutonomy["source"] = bot?.level ? "bot" : account?.level ? "account" : "default";
	const levelScope = bot?.level ? bot : account?.level ? account : undefined;
	const policy: EffectiveAutonomy = {
		level,
		exceptions: [...(bot?.exceptions ?? []), ...(account?.exceptions ?? [])],
		...(levelScope?.until ? { until: levelScope.until } : {}),
	};
	return { policy, source, expired };
}

function matchException(
	policy: Pick<AutonomyPolicy, "exceptions">,
	meta: AutonomyToolMeta,
): AutonomyException | undefined {
	const byTool = policy.exceptions.find((item) => item.tool && item.tool === meta.tool);
	if (byTool) return byTool;
	const connectors = meta.connectors ?? [];
	return policy.exceptions.find(
		(item) => item.connector && connectors.includes(item.connector),
	);
}

/** Modo da exceção que vale para a tool (tool vence conector); `undefined` = nenhuma. */
export function autonomyExceptionMode(
	policy: Pick<AutonomyPolicy, "exceptions">,
	meta: AutonomyToolMeta,
): AutonomyExceptionMode | undefined {
	return matchException(policy, meta)?.mode;
}

/**
 * Gate único. Exceção vence o nível (tool > conector; a primeira da lista
 * vence); sem exceção, vale a matriz nível × classe. `blocked` tira a tool.
 */
export function decideAction(
	policy: EffectiveAutonomy,
	meta: AutonomyToolMeta,
): AutonomyDecision {
	const exception = matchException(policy, meta);
	if (exception) {
		if (exception.mode === "blocked") return "block";
		if (exception.mode === "always_ask") return "ask";
		return "allow";
	}
	if (meta.actionClass === "read") return "allow";
	if (meta.actionClass === "irreversible") return "ask";
	if (policy.level === "autonomous") return "allow";
	if (policy.level === "always_ask") return "ask";
	return meta.host ? "allow" : "ask";
}

// ---------------------------------------------------------------------------
// Resumo em frase (UI e card)

function pluralize(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "6 dias", "5 horas", "menos de 1 hora". */
export function formatAutonomyRemaining(until: string, now: Date): string {
	const ms = Date.parse(until) - now.getTime();
	if (!Number.isFinite(ms) || ms <= 0) return "menos de 1 hora";
	const hours = ms / 3_600_000;
	if (hours < 1) return "menos de 1 hora";
	if (hours < 24) return pluralize(Math.ceil(hours), "hora", "horas");
	return pluralize(Math.ceil(hours / 24), "dia", "dias");
}

function capitalize(text: string): string {
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** `mcp__github__merge_pull_request` → `GitHub · merge pull request`. */
export function autonomyToolLabel(
	tool: string,
	connectorLabel?: (key: string) => string | undefined,
): string {
	const match = /^mcp__([^_].*?)__(.+)$/.exec(tool);
	if (!match) return tool.replace(/_/g, " ");
	const [, slug = "", name = ""] = match;
	const label = connectorLabel?.(slug) ?? capitalize(slug.replace(/_/g, " "));
	return `${label} · ${name.replace(/_/g, " ")}`;
}

const EXCEPTION_PHRASES: Record<AutonomyExceptionMode, string> = {
	always_ask: "sempre pergunta",
	never_ask: "nunca pergunta",
	blocked: "bloqueado",
};

/** "Autônomo por mais 6 dias · Gmail sempre pergunta · GitHub merge bloqueado". */
export function describeAutonomy(
	policy: EffectiveAutonomy,
	now: Date,
	options: { connectorLabel?: (key: string) => string | undefined; inherited?: boolean } = {},
): string {
	const parts: string[] = [];
	let head = AUTONOMY_LEVEL_LABELS[policy.level];
	if (policy.until && Date.parse(policy.until) > now.getTime()) {
		head += ` por mais ${formatAutonomyRemaining(policy.until, now)}`;
	}
	if (options.inherited) head += " (herdado da conta)";
	parts.push(head);
	for (const item of policy.exceptions) {
		const label = item.tool
			? autonomyToolLabel(item.tool, options.connectorLabel)
			: options.connectorLabel?.(item.connector ?? "") ?? capitalize(item.connector ?? "");
		parts.push(`${label} ${EXCEPTION_PHRASES[item.mode]}`);
	}
	return parts.join(" · ");
}

/** Aviso do chat quando a validade vence. */
export function autonomyExpiryNotice(input: {
	scope: "bot" | "account";
	botName?: string;
	to: AutonomyLevel;
}): string {
	const who = input.scope === "bot" ? `do ${input.botName || "bot"}` : "da conta";
	return `A autonomia ${who} voltou para ${AUTONOMY_LEVEL_LABELS[input.to]}.`;
}

/** Substitui/insere exceção pela mesma chave (tool ou conector); a nova vai para a frente. */
export function upsertAutonomyException(
	exceptions: readonly AutonomyException[],
	next: AutonomyException,
): AutonomyException[] {
	const same = (item: AutonomyException) =>
		next.tool ? item.tool === next.tool : !item.tool && item.connector === next.connector;
	return [next, ...exceptions.filter((item) => !same(item))].slice(0, AUTONOMY_MAX_EXCEPTIONS);
}
