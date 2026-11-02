/**
 * Ponte de login do app mobile (Google pelo navegador): validação do retorno e página de volta ao app.
 * Funções puras, sem I/O: as rotas ficam em routes/mobile-auth.ts.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const MAX_RETURN_LENGTH = 2048;
/** O `state` é um nonce do app (CSRF). Só estes caracteres, para poder ir ao link e ao HTML sem escape. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** `code_challenge` PKCE (S256): base64url de 32 bytes = 43 caracteres. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function parseCodeChallenge(raw: unknown): string | null {
	return typeof raw === "string" && CHALLENGE_PATTERN.test(raw) ? raw : null;
}

export function parseCodeVerifier(raw: unknown): string | null {
	return typeof raw === "string" && VERIFIER_PATTERN.test(raw) ? raw : null;
}

export function challengeOf(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

/** Compara em tempo constante o verifier recebido com o challenge guardado. */
export function verifierMatches(verifier: string, challenge: string): boolean {
	const a = Buffer.from(challengeOf(verifier));
	const b = Buffer.from(challenge);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Limite em memória por chave (aqui, o `state` do app), janela fixa. Não cresce sem teto. */
export function createKeyLimiter(max: number, windowMs: number, now: () => number = Date.now) {
	const buckets = new Map<string, { count: number; resetAt: number }>();
	return {
		allow(key: string): boolean {
			const t = now();
			if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
			let bucket = buckets.get(key);
			if (!bucket || bucket.resetAt <= t) {
				if (!bucket && buckets.size > 10_000) return false;
				bucket = { count: 0, resetAt: t + windowMs };
				buckets.set(key, bucket);
			}
			bucket.count += 1;
			return bucket.count <= max;
		},
	};
}

/** Controle, espaço, barra invertida, aspas e `<>`: nada disso é legítimo num deep link e abre brecha em HTML/JS. */
const FORBIDDEN_RETURN_CHARS = /[\u0000-\u0020\u007f\\<>"'`]/;

export function parseMobileState(raw: unknown): string | null {
	return typeof raw === "string" && STATE_PATTERN.test(raw) ? raw : null;
}

/**
 * Retorno aceito: `atlas://…` sempre; `exp://…` (Expo Go) só com `ATLAS_TRUST_EXPO_GO=1`, porque qualquer app no
 * Expo Go consegue abrir esse esquema. Qualquer outra coisa (https, javascript:, intent:, outro app) é recusada.
 * Devolve o texto original (não reescrito) para o app conseguir comparar por prefixo.
 */
export function parseMobileReturn(raw: unknown, options: { trustExpoGo: boolean }): string | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_LENGTH) return null;
	if (FORBIDDEN_RETURN_CHARS.test(raw)) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.username || url.password || url.hash) return null;
	if (url.protocol === "atlas:") return raw;
	if (url.protocol === "exp:" && options.trustExpoGo && url.host) return raw;
	return null;
}

/** Acrescenta `chave=valor` ao deep link sem reescrever o resto (o app compara o prefixo do retorno). */
export function appendReturnParams(returnUrl: string, params: Record<string, string>): string {
	const query = Object.entries(params)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
	return `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}${query}`;
}

export type BridgeCookiePayload = { r: string; s: string; c: string; exp: number };

export function encodeBridgeCookie(payload: BridgeCookiePayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Lê o conteúdo do cookie já com a assinatura conferida; revalida tudo (retorno, state e validade). */
export function decodeBridgeCookie(raw: string, options: { trustExpoGo: boolean; now: number }): { returnUrl: string; state: string; challenge: string } | null {
	try {
		const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<BridgeCookiePayload> | null;
		if (!value || typeof value.exp !== "number" || value.exp <= options.now) return null;
		const returnUrl = parseMobileReturn(value.r, options);
		const state = parseMobileState(value.s);
		const challenge = parseCodeChallenge(value.c);
		return returnUrl && state && challenge ? { returnUrl, state, challenge } : null;
	} catch {
		return null;
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export type DonePageInput = {
	/** Link de volta ao app (com token e state, ou com erro). Null quando não há retorno confiável. */
	link: string | null;
	ok: boolean;
	nonce: string;
};

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--muted:#6b6b6b;--btn:#171717;--btn-fg:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f2f2f2;--muted:#9a9a9a;--btn:#f2f2f2;--btn-fg:#141414}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:22rem;padding:1.5rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:var(--muted)}
a{display:inline-block;padding:.75rem 1.5rem;border-radius:.75rem;background:var(--btn);color:var(--btn-fg);text-decoration:none;font-weight:600}`;

/** CSP da página: só o script desta resposta (nonce) e o estilo embutido; nada de frame, base nem formulário. */
export function donePageCsp(nonce: string): string {
	return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * Página servida pelo próprio servidor depois do Google: tenta voltar ao app por `location` e mostra o botão, cujo
 * toque é o gesto que o Chrome exige para abrir um esquema próprio. O link só entra no HTML escapado e no JS como JSON.
 */
export function renderDonePage({ link, ok, nonce }: DonePageInput): string {
	const title = ok ? "Pronto! Voltando para o app…" : link ? "Não foi possível entrar" : "Esta tentativa de login expirou";
	const text = ok
		? "Se o app não abrir sozinho, toque no botão."
		: link
			? "Volte para o app e tente de novo. Só a conta do dono do Atlas pode entrar."
			: "Volte para o app e toque em “Continuar com Google” outra vez.";
	const button = link ? `<a id="back" href="${escapeHtml(link)}">Voltar para o app</a>` : "";
	const script = link ? `<script nonce="${nonce}">setTimeout(function(){location.replace(${JSON.stringify(link).replace(/</g, "\\u003c")})},150)</script>` : "";
	return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Atlas</title>
<style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${button}</main>${script}</body></html>`;
}
