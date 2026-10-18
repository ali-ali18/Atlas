/**
 * Cofre do usuário: referências de segredo (`{{secret:nome}}`), domínio de site
 * e detector de segredo em texto. Lógica pura (roda no navegador e no servidor).
 * O agente só vê o marcador; o runtime troca pelo valor imediatamente antes de
 * uma chamada de saída permitida e redige o valor de volta nos resultados.
 */

export const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSecretName(name: unknown): name is string {
	return typeof name === "string" && SECRET_NAME_RE.test(name);
}

/** `Minha Chave (X)` -> `minha-chave-x`. */
export function suggestSecretName(raw: string, fallback = "segredo"): string {
	const slug = raw
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || fallback;
}

export type SecretRefField = "username" | "password" | "totp";
export type SecretRef =
	| { kind: "secret"; name: string; raw: string }
	| { kind: "routine"; slug: string; raw: string }
	| { kind: "login"; name: string; field: SecretRefField; raw: string };

const REF_PATTERN =
	"\\{\\{\\s*(secret|login):([A-Za-z0-9_-]{1,64})(?::([A-Za-z0-9_-]{1,64}))?(?:\\.(username|password|totp))?\\s*\\}\\}";

export function secretMarker(name: string): string {
	return `{{secret:${name}}}`;
}
export function routineSecretMarker(slugOrId: string): string {
	return `{{secret:rotina:${slugOrId}}}`;
}
export function loginMarker(name: string, field: SecretRefField): string {
	return `{{login:${name}.${field}}}`;
}

function refFromMatch(match: RegExpMatchArray | RegExpExecArray): SecretRef | null {
	const [raw, kind, a, b, field] = match;
	if (kind === "secret") {
		if (a === "rotina" && b) return { kind: "routine", slug: b, raw };
		if (!b && !field) return { kind: "secret", name: a!, raw };
		return null;
	}
	if (kind === "login" && !b) {
		return { kind: "login", name: a!, field: (field as SecretRefField | undefined) ?? "password", raw };
	}
	return null;
}

export function findSecretRefs(text: string): SecretRef[] {
	const out: SecretRef[] = [];
	for (const match of text.matchAll(new RegExp(REF_PATTERN, "g"))) {
		const ref = refFromMatch(match);
		if (ref) out.push(ref);
	}
	return out;
}

export function hasSecretRef(value: unknown): boolean {
	if (typeof value === "string") return value.includes("{{") && findSecretRefs(value).length > 0;
	if (Array.isArray(value)) return value.some(hasSecretRef);
	if (value && typeof value === "object") return Object.values(value).some(hasSecretRef);
	return false;
}

/** Troca cada marcador pelo retorno de `replacer` (undefined deixa o marcador). */
export function replaceSecretRefs(text: string, replacer: (ref: SecretRef) => string | undefined): string {
	return text.replace(new RegExp(REF_PATTERN, "g"), (...args) => {
		const raw = args[0] as string;
		const m = Object.assign([raw, args[1], args[2], args[3], args[4]], { index: 0, input: raw }) as unknown as RegExpMatchArray;
		const ref = refFromMatch(m);
		return ref ? (replacer(ref) ?? raw) : raw;
	});
}

// ----- domínio -----

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or"]);

function parseUrl(value: string): URL | null {
	const text = value.trim();
	if (!text) return null;
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		return null;
	}
}

export function hostOf(url: string): string | null {
	const parsed = parseUrl(url);
	return parsed ? parsed.hostname.toLowerCase().replace(/\.$/, "") || null : null;
}

/** Domínio registrável aproximado (`app.exemplo.com.br` -> `exemplo.com.br`). */
export function registrableDomain(host: string): string {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")) return host;
	const labels = host.split(".");
	const tld = labels[labels.length - 1]!;
	const second = labels[labels.length - 2]!;
	const take = tld.length === 2 && SECOND_LEVEL.has(second) && labels.length >= 3 ? 3 : 2;
	return labels.slice(-take).join(".");
}

/** A página atual pertence ao site cadastrado? Mesmo domínio registrável (subdomínios ok); http só em localhost. */
export function domainMatches(pageUrl: string, siteUrl: string): boolean {
	const page = parseUrl(pageUrl);
	const site = hostOf(siteUrl);
	if (!page || !site) return false;
	const pageHost = page.hostname.toLowerCase().replace(/\.$/, "");
	const local = pageHost === "localhost" || pageHost === "127.0.0.1";
	if (page.protocol !== "https:" && !local) return false;
	return registrableDomain(pageHost) === registrableDomain(site);
}

/** Nome sugerido a partir do domínio (`www.github.com` -> `github`). */
export function suggestLoginName(url: string): string {
	const host = hostOf(url);
	if (!host) return "";
	return registrableDomain(host.replace(/^www\./, "")).split(".")[0] ?? "";
}

// ----- detector de segredo em texto -----

export type DetectedSecret = {
	kind: "query-secret" | "bearer" | "api-key" | "jwt" | "url-credentials" | "high-entropy";
	/** Só o valor sensível (o que vai para o cofre). */
	value: string;
	start: number;
	end: number;
	suggestedName: string;
};

function entropy(text: string): number {
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / text.length;
		h -= p * Math.log2(p);
	}
	return h;
}

const PLACEHOLDER_VALUE = /^(?:\{\{|<|x{4,}|\*{4,}|\.{3,}|seu[-_ ]|your[-_ ]|example|exemplo|senha|password|token|secret|changeme)/i;

const API_KEY_PATTERNS: Array<{ re: RegExp; name: string }> = [
	{ re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, name: "anthropic" },
	{ re: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, name: "chave-sk" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, name: "github" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, name: "github" },
	{ re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, name: "slack" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, name: "aws" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, name: "google" },
	{ re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g, name: "stripe" },
	{ re: /\bglpat-[A-Za-z0-9_-]{20,}/g, name: "gitlab" },
];

const QUERY_SECRET_SOURCE =
	"[?&](secret|token|api[_-]?key|apikey|access[_-]?token|key|password|passwd|pwd|auth)=([^&\\s\"'<>#]{6,})";

export function detectSecretsInText(text: string): DetectedSecret[] {
	const found: DetectedSecret[] = [];
	const overlaps = (start: number, end: number) => found.some((item) => start < item.end && end > item.start);
	const add = (kind: DetectedSecret["kind"], value: string, start: number, suggestedName: string) => {
		const end = start + value.length;
		if (value.length < 6 || PLACEHOLDER_VALUE.test(value) || overlaps(start, end)) return;
		found.push({ kind, value, start, end, suggestedName });
	};

	for (const m of text.matchAll(new RegExp(QUERY_SECRET_SOURCE, "gi"))) {
		const value = m[2]!;
		const label = m[1]!.toLowerCase();
		add("query-secret", value, m.index! + m[0].length - value.length, label === "secret" ? "webhook-secret" : suggestSecretName(label));
	}
	for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+):([^\s/@]{3,})@/gi)) {
		const value = m[2]!;
		add("url-credentials", value, m.index! + m[0].length - 1 - value.length, "senha-url");
	}
	for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g)) add("jwt", m[0], m.index!, "jwt");
	for (const { re, name } of API_KEY_PATTERNS) {
		for (const m of text.matchAll(re)) add("api-key", m[0], m.index!, name);
	}
	for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g)) {
		add("bearer", m[1]!, m.index! + m[0].length - m[1]!.length, "token");
	}
	for (const m of text.matchAll(/(?<![A-Za-z0-9_\-/.])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/.])/g)) {
		const token = m[0];
		if (/^[0-9a-f]+$/i.test(token)) continue; // hash/sha de commit
		if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
		if (entropy(token) < 3.6) continue;
		add("high-entropy", token, m.index!, "segredo");
	}
	return found.sort((a, b) => a.start - b.start);
}

/** Troca cada trecho detectado pelo marcador de `names[i]` (mesma ordem de `detectSecretsInText`). */
export function replaceDetected(text: string, detected: readonly DetectedSecret[], names: readonly string[]): string {
	let out = "";
	let cursor = 0;
	detected.forEach((item, index) => {
		out += text.slice(cursor, item.start) + secretMarker(names[index] ?? item.suggestedName);
		cursor = item.end;
	});
	return out + text.slice(cursor);
}
