/**
 * Limpeza de segredos/PII antes de qualquer coisa sair para fora (Sentry, diagnóstico).
 * Isomórfico (sem imports de node). Regras: chave sensível => "[Filtered]"; strings têm
 * `?secret=`, `Bearer ...`, chaves `sk-...` e blocos PEM mascarados; PII do usuário é removida.
 */

import { redactPreviewUrls } from "./preview.js";

export const FILTERED = "[Filtered]";

/** Nome de campo/cabeçalho que nunca deve sair com valor. */
const SENSITIVE_KEY =
	/authorization|cookie|secret|token|passw(or)?d|passwd|api[-_]?key|apikey|private[-_]?key|credential|session|dsn|signature|x-atlas-hook|pepper|encryption[-_]?key|vapid|bearer|auth(?!or)/i;

const QUERY_SECRET = /((?:^|[?&;])(?:secret|token|key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|code|state|signature|sig|password|auth)=)[^&#\s"']+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const API_KEY_LIKE = /\b(?:sk|pk|rk|xox[abprs]|ghp|gho|ghu|ghs|github_pat|AKIA|AIza)[-_A-Za-z0-9]{12,}/g;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;
const MAX_DEPTH = 8;
const MAX_STRING = 4000;

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key);
}

/** Mascara segredos dentro de um texto (URLs, mensagens de erro, logs). */
export function scrubString(text: string): string {
	let out = text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
	// O `cap` da prévia (modo básico) é credencial no caminho: não sai em `request.url`, `transaction`, breadcrumbs nem mensagens.
	out = redactPreviewUrls(out);
	out = out.replace(PEM, FILTERED);
	out = out.replace(QUERY_SECRET, `$1${FILTERED}`);
	out = out.replace(BEARER, `$1 ${FILTERED}`);
	out = out.replace(API_KEY_LIKE, FILTERED);
	return out;
}

/** Cópia profunda com segredos mascarados (não muta a entrada; ciclos e profundidade limitados). */
export function scrubValue<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
	if (typeof value === "string") return scrubString(value) as T;
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return value;
	if (depth >= MAX_DEPTH) return FILTERED as T;
	if (seen.has(value as object)) return "[Circular]" as T;
	seen.add(value as object);
	if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen)) as T;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(item, depth + 1, seen);
	}
	return out as T;
}

type SentryLikeEvent = {
	user?: Record<string, unknown>;
	request?: {
		headers?: Record<string, unknown>;
		cookies?: unknown;
		data?: unknown;
		query_string?: unknown;
		url?: string;
		env?: unknown;
	};
	extra?: unknown;
	contexts?: unknown;
	breadcrumbs?: unknown;
	message?: string;
	exception?: unknown;
	tags?: unknown;
	server_name?: string;
	[key: string]: unknown;
};

/**
 * Para o `beforeSend` do Sentry: remove cookies, corpo e query das requisições, cabeçalhos
 * sensíveis, e-mail/IP do usuário (fica só o id) e mascara o resto.
 */
export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
	const copy = scrubValue(event) as T;
	if (copy.request) {
		delete copy.request.cookies;
		delete copy.request.data;
		delete copy.request.env;
		if (typeof copy.request.query_string === "string") copy.request.query_string = scrubString(copy.request.query_string);
		else delete copy.request.query_string;
		if (typeof event.request?.url === "string") copy.request.url = scrubString(event.request.url);
	}
	if (copy.user) {
		const id = typeof event.user?.id === "string" ? event.user.id : undefined;
		copy.user = id ? { id } : {};
	}
	delete copy.server_name;
	return copy;
}
