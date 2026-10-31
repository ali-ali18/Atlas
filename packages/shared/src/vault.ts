import { parse as parseTld } from "tldts";

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

/** Resultado da Public Suffix List (ICANN + sufixos privados de plataforma: vercel.app, github.io, pages.dev…). */
function psl(host: string) {
	return parseTld(host, { allowPrivateDomains: true });
}

/**
 * Domínio registrável pela Public Suffix List, incluindo os sufixos privados de plataforma
 * (`atacante.vercel.app` é um domínio registrável por si; `vercel.app` é sufixo). IP, localhost
 * e o próprio sufixo voltam como vieram.
 */
export function registrableDomain(host: string): string {
	return psl(host).domain ?? host;
}

/** Host sem ponto final e sem `www.` (`www.x.com` ≡ `x.com`). */
function canonicalHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

function isLocalHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * A página atual é o site cadastrado? SÓ o host exato (`www.` e o domínio sem `www.` são o mesmo site). Qualquer outro
 * subdomínio é outro site (salvo `google.com`, `sites.google.com` NÃO casa: lá qualquer pessoa publica página) e cai
 * no cartão de vínculo. Em localhost e IP a porta também conta (`localhost:3000` ≠ `localhost:9999`). https sempre;
 * http só em localhost.
 */
export function domainMatches(pageUrl: string, siteUrl: string): boolean {
	const page = parseUrl(pageUrl);
	const site = parseUrl(siteUrl);
	if (!page || !site) return false;
	const pageHost = page.hostname.toLowerCase().replace(/\.$/, "");
	const local = isLocalHost(pageHost);
	if (page.protocol !== "https:" && !local) return false;
	if (canonicalHost(pageHost) !== canonicalHost(site.hostname)) return false;
	const exactPort = local || psl(pageHost).isIp === true;
	return !exactPort || page.port === site.port;
}

/** Nome sugerido a partir do domínio (`www.github.com` -> `github`). */
export function suggestLoginName(url: string): string {
	const host = hostOf(url);
	if (!host) return "";
	return registrableDomain(host.replace(/^www\./, "")).split(".")[0] ?? "";
}

/** Palavras do nome/rótulo do item (minúsculas, sem acento, 4+ letras) para casar com o domínio. */
function nameTokens(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 4);
}

/**
 * Item sem URL salva: o nome/rótulo casa com o domínio da página? Conservador: alguma palavra do nome é
 * IGUAL ao nome do domínio registrável (`Painel - Kodea` ↔ `panel.kodea.com.br`, via "kodea"). Só https.
 * `kodea.evil.com` não casa (o registrável é `evil.com`); "painel" não casa com "panel".
 */
export function nameMatchesSite(names: readonly string[], pageUrl: string): boolean {
	const page = parseUrl(pageUrl);
	if (!page) return false;
	const host = page.hostname.toLowerCase().replace(/\.$/, "");
	const local = host === "localhost" || host === "127.0.0.1";
	if (page.protocol !== "https:" || local) return false;
	const label = registrableDomain(host).split(".")[0] ?? "";
	if (label.length < 4) return false;
	return names.some((name) => nameTokens(name).includes(label));
}

export type VaultLoginCandidate = { kind: string; name: string; label?: string; siteUrl?: string | null };
export type VaultLoginPick<T extends VaultLoginCandidate> =
	| { kind: "match"; item: T; byName: boolean }
	| { kind: "ambiguous"; items: T[] }
	| { kind: "none" };

/**
 * Qual login do cofre serve a página atual? Primeiro pelo site salvo (host exato); sem isso,
 * pelo nome (itens sem URL). Mais de um candidato = ambíguo: o modelo pergunta qual item usar, o runtime não chuta.
 */
export function pickVaultLoginForPage<T extends VaultLoginCandidate>(items: readonly T[], pageUrl: string): VaultLoginPick<T> {
	const logins = items.filter((item) => item.kind === "login");
	const byUrl = logins.filter((item) => item.siteUrl && domainMatches(pageUrl, item.siteUrl));
	if (byUrl.length === 1) return { kind: "match", item: byUrl[0]!, byName: false };
	if (byUrl.length > 1) return { kind: "ambiguous", items: byUrl };
	const byName = logins.filter((item) => !item.siteUrl && nameMatchesSite([item.name, item.label ?? ""], pageUrl));
	if (byName.length === 1) return { kind: "match", item: byName[0]!, byName: true };
	if (byName.length > 1) return { kind: "ambiguous", items: byName };
	return { kind: "none" };
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
