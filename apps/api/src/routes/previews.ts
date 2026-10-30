import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { DevSessionRecord } from "@workspace/db";
import {
	isPreviewPort,
	normalizePreviewBaseDomain,
	isSafePreviewRest,
	normalizePreviewPath,
	parsePreviewBasicPath,
	previewCapIsLive,
	previewBaseDomainConflict,
	previewBasicPrefix,
	previewIdFromHost,
	previewOrigin,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Prévia privada do projeto web da sessão de código. Dois modos:
 * - **completo** (com `ATLAS_PREVIEW_BASE_DOMAIN`): ORIGEM SEPARADA do Atlas (`https://<id>.<base>/`).
 * - **básico** (sem domínio, o padrão): na origem do Atlas, sob `/v1/previews/<id>/p/`, mas toda resposta leva
 *   `Content-Security-Policy: sandbox` SEM `allow-same-origin`: o documento roda numa origem opaca (`origin === "null"`),
 *   sem cookie nem storage do Atlas, e o cookie de login não vai nas requisições vindas dele (SameSite).
 * O JavaScript do projeto é código do usuário/modelo: nunca roda na origem do Atlas com o cookie de login.
 *
 * Fluxo: o link do chat abre `${ATLAS_URL}/v1/previews/:id/open` (requireUser + dono, 404 para outro usuário);
 * ele mostra um token curto e redireciona ao domínio da prévia, que o troca por um cookie HttpOnly
 * restrito àquele host. O destino do proxy vem só do banco (sessão do dono → IP do container + porta
 * registrada); nada do que chega na requisição escolhe host ou porta (SSRF).
 */

export const PREVIEW_COOKIE = "atlas_preview";
export const PREVIEW_AUTH_PATH = "/__atlas_preview_auth";
export const PREVIEW_OPEN_TOKEN_TTL_MS = 30_000;
export const PREVIEW_COOKIE_TTL_MS = 60 * 60_000;
const TARGET_CACHE_MS = 5_000;
/** Sem tráfego por este tempo o proxy HTTP desiste (SSE/long-poll com batimento passam). */
const UPSTREAM_IDLE_MS = 120_000;
const SWEEP_EVERY_MS = 30_000;
const TOUCH_EVERY_MS = 30_000;
const WS_HALF_CLOSE_GRACE_MS = 1_000;

// ---- Configuração --------------------------------------------------------

export type PreviewConfig = {
	/** `null` = modo básico (prévia sob o caminho do Atlas, em origem opaca). */
	baseDomain: string | null;
	scheme: "http" | "https";
	/** Origem do Atlas (`ATLAS_URL`): vai no link entregue ao usuário. */
	atlasUrl: string;
	secret: string;
};

export function previewMode(config: Pick<PreviewConfig, "baseDomain">): "full" | "basic" {
	return config.baseDomain ? "full" : "basic";
}

/**
 * `null` = prévia desligada (sem `ATLAS_URL` ou segredo). Sem domínio-base, ou com domínio inválido/no mesmo site do Atlas,
 * cai no modo básico (zero configuração); com domínio válido e separado, modo completo.
 */
export function loadPreviewConfig(env: NodeJS.ProcessEnv = process.env): PreviewConfig | null {
	const atlasUrl = env.ATLAS_URL?.trim().replace(/\/+$/, "");
	const secret = env.BETTER_AUTH_SECRET ?? "";
	if (!atlasUrl || !secret) return null;
	const baseDomain = previewConfigProblem(env) ? null : normalizePreviewBaseDomain(env.ATLAS_PREVIEW_BASE_DOMAIN);
	return { baseDomain, atlasUrl, secret, scheme: atlasUrl.startsWith("https://") ? "https" : "http" };
}

/** Por que o modo completo não ligou apesar de `ATLAS_PREVIEW_BASE_DOMAIN` estar definida (a prévia segue no modo básico; para o log de boot); `null` = nada a avisar. */
export function previewConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
	const baseDomain = normalizePreviewBaseDomain(env.ATLAS_PREVIEW_BASE_DOMAIN);
	const atlasUrl = env.ATLAS_URL?.trim().replace(/\/+$/, "");
	if (!env.ATLAS_PREVIEW_BASE_DOMAIN?.trim()) return null;
	if (!baseDomain) return "ATLAS_PREVIEW_BASE_DOMAIN inválido";
	if (!atlasUrl || !(env.BETTER_AUTH_SECRET ?? "")) return "faltam ATLAS_URL ou BETTER_AUTH_SECRET";
	if (env.ATLAS_PREVIEW_ALLOW_SAME_SITE === "1") return null;
	const conflict = previewBaseDomainConflict(baseDomain, atlasUrl);
	return conflict ? `${conflict}; use um domínio registrável separado (ou ATLAS_PREVIEW_ALLOW_SAME_SITE=1 por sua conta e risco)` : null;
}

/** Linha de log do boot: diz o modo e, se `ATLAS_PREVIEW_BASE_DOMAIN` foi definida mas não serve, o motivo do modo completo não ligar. */
export function previewBootLog(env: NodeJS.ProcessEnv = process.env): { level: "info" | "warn"; message: string } | null {
	const config = loadPreviewConfig(env);
	if (!config) return null;
	const problem = previewConfigProblem(env);
	if (problem) return { level: "warn", message: `[preview] prévia completa DESLIGADA, usando o modo básico: ${problem}` };
	return { level: "info", message: `[preview] modo ${previewMode(config) === "full" ? `completo (${config.baseDomain})` : "básico (sem ATLAS_PREVIEW_BASE_DOMAIN)"}` };
}

// ---- Tokens --------------------------------------------------------------

/** `open`: vai na URL do redirect (60 s). `session`: vai no cookie (até 1 h). Chaves distintas: um não vale como o outro. */
type TokenKind = "open" | "session";

function mac(kind: TokenKind, payload: string, secret: string): string {
	return createHmac("sha256", `atlas-preview:${kind}:${secret}`).update(payload).digest("base64url");
}

export function signPreviewToken(kind: TokenKind, input: { previewId: string; userId: string }, secret: string, ttlMs: number, now = Date.now()): string {
	// `j` torna cada token único (o de entrada é de uso único; ver `consumeOpenToken`).
	const payload = Buffer.from(JSON.stringify({ p: input.previewId, u: input.userId, e: now + ttlMs, j: randomBytes(9).toString("base64url") })).toString("base64url");
	return `${payload}.${mac(kind, payload, secret)}`;
}

export type PreviewTokenClaims = { userId: string; expiresAt: number; jti: string };

/** Devolve o userId se a assinatura bate, não expirou e é desta prévia. */
export function verifyPreviewToken(kind: TokenKind, token: string | null | undefined, previewId: string, secret: string, now = Date.now()): string | null {
	return readPreviewToken(kind, token, previewId, secret, now)?.userId ?? null;
}

export function readPreviewToken(kind: TokenKind, token: string | null | undefined, previewId: string, secret: string, now = Date.now()): PreviewTokenClaims | null {
	if (!token || !secret) return null;
	const [payload, given, extra] = token.split(".");
	if (!payload || !given || extra !== undefined) return null;
	const expected = Buffer.from(mac(kind, payload, secret));
	const actual = Buffer.from(given);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: unknown; u?: unknown; e?: unknown; j?: unknown };
		if (typeof data.p !== "string" || typeof data.u !== "string" || typeof data.e !== "number") return null;
		if (data.p !== previewId || data.e <= now) return null;
		return { userId: data.u, expiresAt: data.e, jti: typeof data.j === "string" ? data.j : "" };
	} catch {
		return null;
	}
}

/** Todos os valores com esse nome: um cookie plantado por outro subdomínio não pode esconder o legítimo (cookie tossing). */
function readCookies(header: string | null | undefined, name: string): string[] {
	const values: string[] = [];
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
	}
	return values;
}

/** Reescreve um endereço do servidor interno (IP do container, localhost, 0.0.0.0) para a origem pública da prévia. */
export function rewriteToPublicOrigin(value: string, upstreamHost: string, publicOrigin: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return value;
	}
	const internal = new Set([upstreamHost, "127.0.0.1", "localhost", "0.0.0.0", "[::1]"]);
	if (!/^https?:$/.test(url.protocol) || !internal.has(url.hostname)) return value;
	// Origem pura (Access-Control-Allow-Origin) continua sem barra.
	if (!value.endsWith("/") && url.pathname === "/" && !url.search && !url.hash) return publicOrigin;
	return `${publicOrigin}${url.pathname}${url.search}${url.hash}`;
}

function rewriteRefresh(value: string, upstreamHost: string, publicOrigin: string): string {
	return value.replace(/(url\s*=\s*)(\S+)/i, (_m, head: string, target: string) => `${head}${rewriteToPublicOrigin(target, upstreamHost, publicOrigin)}`);
}

/** Tira o cookie de autenticação da prévia do que segue ao projeto (os cookies do próprio app passam). */
export function stripPreviewCookie(header: string | null | undefined): string | undefined {
	const kept = (header ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part && part.slice(0, part.indexOf("=") === -1 ? part.length : part.indexOf("=")).trim() !== PREVIEW_COOKIE);
	return kept.length ? kept.join("; ") : undefined;
}

/**
 * Set-Cookie do projeto: sem `Domain=` (um cookie para o domínio-base valeria em todas as prévias) e nunca
 * o nosso nome de cookie. O resto do cookie do app (nome, valor, Path, SameSite…) passa como veio.
 */
export function rewriteUpstreamSetCookie(value: string): string | null {
	const name = value.slice(0, value.indexOf("=") === -1 ? value.length : value.indexOf("=")).trim();
	if (name === PREVIEW_COOKIE) return null;
	return value
		.split(";")
		.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
		.join(";");
}

// ---- Dependências --------------------------------------------------------

export type PreviewDeps = {
	config: PreviewConfig | null;
	getSessionById: (id: string) => Promise<DevSessionRecord | null>;
	getOwnedSession: (id: string, userId: string) => Promise<DevSessionRecord | null>;
	/** IP do container da sessão (só no modo de rede compartilhada) ou `null`. Nunca vem da requisição. */
	resolveContainerHost: (sessionId: string) => Promise<string | null>;
	/** Mantém `lastActiveAt` em dia para o container não parar por ociosidade enquanto a prévia é vista. */
	touch: (sessionId: string) => Promise<void>;
	now?: () => number;
	/** Intervalo da revalidação dos WebSockets abertos (padrão 30 s). */
	sweepEveryMs?: number;
};

type Target = { host: string; port: number; path: string; userId: string; expiresAt: number; basePrefixed: boolean; cap: string | undefined };

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);
const REQUEST_STRIP = new Set([...HOP_BY_HOP, "authorization", "host", "origin", "referer", "forwarded", "x-real-ip", "cookie"]);

const SECURITY_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Content-Type-Options": "nosniff",
};

/**
 * Modo básico: o documento fica na origem do Atlas, então o sandbox (sem `allow-same-origin`, sem `allow-top-navigation`) é o que
 * o isola. COOP corta o vínculo com a janela que abriu o link; CORP `cross-origin` é necessário porque os subrecursos são pedidos
 * pela origem opaca (cross-origin para o Atlas) e com `same-origin` a própria página quebraria.
 *
 * CORS: a origem opaca é cross-origin ao Atlas, então `<script type="module">`, `crossorigin`, fontes e `fetch` são pedidos
 * CORS sem credenciais. `Access-Control-Allow-Origin: *` (nunca com credenciais) os libera; a autenticação é o `cap` no caminho.
 */
export const PREVIEW_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
export const BASIC_HEADERS: Record<string, string> = {
	"Content-Security-Policy": PREVIEW_SANDBOX_CSP,
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "cross-origin",
	"X-Frame-Options": "SAMEORIGIN",
	// Cache compartilhado (CDN/proxy) nunca guarda: a URL já é a credencial, e `public`/`s-maxage` do projeto não valem.
	"Cache-Control": "private, no-store",
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
	"Access-Control-Max-Age": "600",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Content-Type-Options": "nosniff",
};

/**
 * Cabeçalhos do projeto que não podem valer na origem do Atlas: política de segurança/CORS/cache que competem com a nossa e
 * os que afetam o Atlas inteiro (HSTS, Clear-Site-Data, Service-Worker-Allowed, NEL/Report-To, Alt-Svc, Client Hints). `Link`
 * sai porque pode pré-carregar/conectar a hosts externos com a identidade da página.
 */
const BASIC_DROP = new Set([
	"content-security-policy", "content-security-policy-report-only", "cross-origin-opener-policy", "cross-origin-resource-policy",
	"cross-origin-embedder-policy", "x-frame-options", "cache-control", "expires", "pragma", "set-cookie", "service-worker-allowed",
	"clear-site-data", "strict-transport-security", "public-key-pins", "expect-ct", "alt-svc", "report-to", "reporting-endpoints", "nel",
	"accept-ch", "critical-ch", "origin-agent-cluster", "link", "permissions-policy", "document-policy", "timing-allow-origin",
]);

/** Põe os cabeçalhos do modo básico (sobrepondo qualquer um parecido) em qualquer resposta de `/p/`. */
export function applyBasicHeaders(headers: Headers, requestHeaders?: Headers): void {
	for (const key of [...headers.keys()]) if (BASIC_DROP.has(key.toLowerCase()) || key.toLowerCase().startsWith("access-control-")) headers.delete(key);
	for (const [key, value] of Object.entries(BASIC_HEADERS)) headers.set(key, value);
	const asked = requestHeaders?.get("access-control-request-headers");
	headers.set("Access-Control-Allow-Headers", asked && /^[\w\-, ]{1,500}$/.test(asked) ? asked : "*");
}

/**
 * Middleware de `/v1/previews/:id/p/*`: garante os cabeçalhos do modo básico em TODA resposta, inclusive as que não passam
 * pelo proxy (429 do limite por IP, 413 do limite de corpo, 500 do `onError`). Registrar antes do limite e do `requireUser`.
 */
export const basicResponseHeaders: MiddlewareHandler = async (c, next) => {
	await next();
	const res = new Response(c.res.body, c.res);
	applyBasicHeaders(res.headers, c.req.raw.headers);
	c.res = res;
};

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra } });
}

function basicText(status: number, body: string): Response {
	const res = text(status, body, BASIC_HEADERS);
	applyBasicHeaders(res.headers);
	return res;
}

/**
 * `Location`/`Refresh` do projeto no modo básico: endereço interno, da própria origem do Atlas ou caminho absoluto (`/x`) entra no
 * prefixo da prévia (que inclui o `cap`); caminho relativo que continua dentro do prefixo e quem já tem o prefixo ficam como estão (relativo que
 * resolve para fora, como `../../../x`, é bloqueado). Devolve `null` (BLOQUEADO)
 * para qualquer destino que não seja da prévia: `//host`, `\\host`, `/\host`, URL absoluta externa, esquema que não é http(s) e
 * valor com controle/espaço de borda (o navegador os remove e `/\t/evil` viraria `//evil`). Sem isso a origem do Atlas serviria de
 * redirecionamento aberto para um site qualquer.
 */
export function rewriteLocationIntoPrefix(value: string, upstreamHost: string, atlasOrigin: string, prefix: string, requestPath = prefix): string | null {
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(value) || value !== value.trim()) return null;
	if (/^[\\/]{2}/.test(value) || value.startsWith("/\\")) return null;
	const under = (path: string) => (path.startsWith(prefix) || path === prefix.slice(0, -1) ? path : `${prefix}${path.slice(1)}`);
	if (value.startsWith("/")) return under(value);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		// Relativo: resolve contra o endereço do pedido (no Atlas) e só fica se continuar DENTRO da prévia (`../../../x` sai: bloqueia).
		if (value.includes("\\")) return null;
		try {
			const resolved = new URL(value, `${atlasOrigin}${requestPath}`);
			return resolved.origin === atlasOrigin && (resolved.pathname.startsWith(prefix) || resolved.pathname === prefix.slice(0, -1)) ? value : null;
		} catch {
			return null;
		}
	}
	const internal = new Set([upstreamHost, "127.0.0.1", "localhost", "0.0.0.0", "[::1]"]);
	if (!/^https?:$/.test(url.protocol) || !(internal.has(url.hostname) || url.origin === atlasOrigin)) return null;
	return `${atlasOrigin}${under(`${url.pathname}${url.search}${url.hash}`)}`;
}

export function createPreviewService(deps: PreviewDeps) {
	const now = deps.now ?? Date.now;
	const targets = new Map<string, { at: number; value: Target }>();
	const touched = new Map<string, number>();
	/** Tokens de entrada já usados (jti → vencimento). Memória do processo: com várias instâncias da api, um token pode valer uma vez por instância dentro dos 30 s. */
	const usedOpenTokens = new Map<string, number>();
	type Live = { userId: string; socket: Duplex; upstream: net.Socket; cookieExpiresAt: number; timer?: NodeJS.Timeout };
	const live = new Map<string, Set<Live>>();
	let sweeper: NodeJS.Timeout | undefined;

	function consumeOpenToken(jti: string, expiresAt: number): boolean {
		if (!jti) return false;
		for (const [key, exp] of usedOpenTokens) if (exp <= now()) usedOpenTokens.delete(key);
		if (usedOpenTokens.has(jti)) return false;
		usedOpenTokens.set(jti, expiresAt);
		return true;
	}

	function closeLive(item: Live): void {
		if (item.timer) clearTimeout(item.timer);
		item.socket.destroy();
		item.upstream.destroy();
	}

	/** Fecha os WebSockets da prévia e esquece o destino em cache. */
	function invalidate(id: string): void {
		targets.delete(id);
		const set = live.get(id);
		if (set) for (const item of set) closeLive(item);
		live.delete(id);
	}

	/**
	 * Revalida no banco o destino de cada prévia com WebSocket aberto: vencida, encerrada (`preview_stop` roda no worker,
	 * então só o banco avisa), ambiente parado, dono diferente ou cookie vencido derrubam o socket.
	 */
	async function sweep(): Promise<void> {
		for (const [id, set] of [...live]) {
			const target = await lookup(id).catch(() => null);
			if (!target) { invalidate(id); continue; }
			targets.set(id, { at: now(), value: target });
			for (const item of [...set]) {
				if (item.userId !== target.userId || item.cookieExpiresAt <= now()) { closeLive(item); set.delete(item); }
			}
			if (set.size === 0) live.delete(id);
		}
		if (live.size === 0 && sweeper) { clearInterval(sweeper); sweeper = undefined; }
	}

	function track(id: string, item: Live, expiresAt: number): void {
		const set = live.get(id) ?? new Set<Live>();
		live.set(id, set);
		set.add(item);
		const untilMs = Math.min(expiresAt, item.cookieExpiresAt) - now();
		item.timer = setTimeout(() => closeLive(item), Math.max(0, untilMs));
		item.timer.unref();
		item.socket.once("close", () => {
			if (item.timer) clearTimeout(item.timer);
			set.delete(item);
			if (set.size === 0 && live.get(id) === set) live.delete(id);
		});
		sweeper ??= setInterval(() => void sweep(), deps.sweepEveryMs ?? SWEEP_EVERY_MS);
		sweeper.unref();
	}

	/** Prévia ativa → destino. Tudo do banco: dono, porta registrada e IP do container. */
	async function resolveTarget(id: string): Promise<Target | null> {
		const cached = targets.get(id);
		// O vencimento é conferido a cada requisição, mesmo com cache; resultado negativo nunca fica em cache.
		if (cached && now() - cached.at < TARGET_CACHE_MS && cached.value.expiresAt > now()) return cached.value;
		const value = await lookup(id);
		if (value) targets.set(id, { at: now(), value });
		else targets.delete(id);
		if (targets.size > 200) for (const key of targets.keys()) { targets.delete(key); break; }
		return value;
	}

	async function lookup(id: string): Promise<Target | null> {
		const row = await deps.getSessionById(id);
		const preview = row?.preview;
		if (!row || !preview || row.status !== "RUNNING") return null;
		const expiresAt = Date.parse(preview.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= now()) return null;
		if (!isPreviewPort(preview.port)) return null;
		const host = await deps.resolveContainerHost(row.id);
		return host ? { host, port: preview.port, path: normalizePreviewPath(preview.path) ?? "/", userId: row.userId, expiresAt, basePrefixed: preview.basePrefixed === true, cap: previewCapIsLive(preview.capIssuedAt, now()) ? preview.cap : undefined } : null;
	}

	function noteActivity(id: string): void {
		const last = touched.get(id) ?? 0;
		if (now() - last < TOUCH_EVERY_MS) return;
		touched.set(id, now());
		if (touched.size > 200) for (const [key, at] of touched) if (now() - at >= TOUCH_EVERY_MS) touched.delete(key);
		void deps.touch(id).catch(() => undefined);
	}

	/** Dono autenticado pelo cookie desta prévia; `null` se não houver cookie válido. */
	function cookieClaims(id: string, cookieHeader: string | null | undefined): PreviewTokenClaims | null {
		const config = deps.config;
		if (!config) return null;
		for (const value of readCookies(cookieHeader, PREVIEW_COOKIE)) {
			const claims = readPreviewToken("session", value, id, config.secret, now());
			if (claims) return claims;
		}
		return null;
	}

	async function authenticate(id: string, cookieHeader: string | null | undefined): Promise<{ target: Target; cookieExpiresAt: number } | { response: Response }> {
		const claims = cookieClaims(id, cookieHeader);
		if (!claims) return { response: text(401, "Abra a prévia pelo link enviado no chat.") };
		const userId = claims.userId;
		const target = await resolveTarget(id);
		// Prévia inexistente, vencida, parada ou de outro dono: mesma resposta (não revela que existe).
		if (!target || target.userId !== userId) return { response: text(404, "Prévia indisponível.") };
		return { target, cookieExpiresAt: claims.expiresAt };
	}

	function baseUrlHost(request: { headers: { get(name: string): string | null } }): string | null {
		return request.headers.get("host");
	}

	/** Trata a requisição se o Host é de prévia; `null` = não é (segue para as rotas normais). */
	async function handleRequest(request: Request): Promise<Response | null> {
		const config = deps.config;
		const id = previewIdFromHost(baseUrlHost(request), config?.baseDomain ?? null);
		if (!config?.baseDomain || !id) return null;
		const url = new URL(request.url);

		if (url.pathname === PREVIEW_AUTH_PATH) return handleAuth(config, id, url);

		const auth = await authenticate(id, request.headers.get("cookie"));
		if ("response" in auth) return auth.response;
		noteActivity(id);
		return proxyHttp(request, auth.target, `${url.pathname}${url.search}`, previewOrigin({ scheme: config.scheme, baseDomain: config.baseDomain, id }), request.headers.get("host") ?? "");
	}

	/** `cap` do caminho confere com o gravado na prévia (tempo constante). */
	function capMatches(expected: string | undefined, given: string): boolean {
		if (!expected || !given) return false;
		const a = Buffer.from(expected);
		const b = Buffer.from(given);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/**
	 * Prévia do modo básico (`/v1/previews/:id/p/<cap>/*`): rota pública no `requireUser`; a autenticação é o `cap` do caminho
	 * (segredo aleatório da prévia, vence com ela). Sem cookie: a origem opaca do sandbox não os leva em pedidos CORS.
	 * Falha de qualquer tipo (id, cap, vencida, parada) responde igual: 401 "Link expirado".
	 */
	async function handleBasicRequest(request: Request): Promise<Response> {
		const config = deps.config;
		const url = new URL(request.url);
		const parsed = parsePreviewBasicPath(url.pathname);
		// Modo completo (ou desligado): o caminho não existe na origem do Atlas.
		if (!config || previewMode(config) !== "basic" || !parsed) return basicText(404, "Prévia indisponível.");
		const { id, cap, rest } = parsed;
		const target = await resolveTarget(id);
		if (!target || !capMatches(target.cap, cap)) return basicText(401, "Link expirado. Peça o link da prévia de novo no chat.");
		// Nada de `..`, `//`, `\`, `%2f` ou NUL no que segue ao projeto: o prefixo não se escapa e o caminho não é ambíguo.
		if (!isSafePreviewRest(rest)) return basicText(404, "Prévia indisponível.");
		noteActivity(id);
		if (request.method === "OPTIONS") {
			const res = new Response(null, { status: 204 });
			applyBasicHeaders(res.headers, request.headers);
			return res;
		}
		const prefix = previewBasicPrefix(id, cap);
		// Servidor configurado com a base: ele espera o prefixo; senão o prefixo é tirado (servidor estático, caminhos relativos).
		const upstreamPath = `${target.basePrefixed ? url.pathname : rest}${url.search}`;
		return proxyHttp(request, target, upstreamPath, config.atlasUrl, new URL(config.atlasUrl).host, prefix, url.pathname);
	}

	/** Troca o token curto do redirect pelo cookie da prévia e segue para o caminho registrado. */
	async function handleAuth(config: PreviewConfig, id: string, url: URL): Promise<Response> {
		const claims = readPreviewToken("open", url.searchParams.get("t"), id, config.secret, now());
		if (!claims) return text(401, "Link expirado. Peça o link da prévia de novo no chat.");
		// Uso único: o token aparece na URL (logs do proxy) e não deve valer uma segunda vez.
		if (!consumeOpenToken(claims.jti, claims.expiresAt)) return text(401, "Link já usado. Peça o link da prévia de novo no chat.");
		const userId = claims.userId;
		const target = await resolveTarget(id);
		if (!target || target.userId !== userId) return text(404, "Prévia indisponível.");
		const path = target.path;
		const maxAge = Math.max(1, Math.floor(Math.min(PREVIEW_COOKIE_TTL_MS, target.expiresAt - now()) / 1000));
		const cookie = signPreviewToken("session", { previewId: id, userId }, config.secret, maxAge * 1000, now());
		// Sem `Domain`: o cookie vale só para este host. Sem `Secure` em http (desenvolvimento local).
		const attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.scheme === "https" ? "; Secure" : ""}`;
		return new Response(null, {
			status: 302,
			headers: { Location: path, "Set-Cookie": `${PREVIEW_COOKIE}=${cookie}; ${attrs}`, "Cache-Control": "no-store", ...SECURITY_HEADERS },
		});
	}

	/** `basicPrefix`: modo básico (ver topo do arquivo): nenhum cookie vai ao projeto, `Set-Cookie` dele é descartado e os cabeçalhos de sandbox entram em toda resposta. */
	function proxyHttp(request: Request, target: Target, upstreamPath: string, publicOrigin: string, publicHost: string, basicPrefix?: string, basicPath?: string): Promise<Response> {
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			if (!REQUEST_STRIP.has(key) && !key.startsWith("x-forwarded-")) headers[key] = value;
		});
		// Modo básico: o cookie de sessão do Atlas nunca segue (nem o da prévia nem qualquer outro); o app não tem cookies próprios (Set-Cookie é descartado).
		const cookies = basicPrefix ? undefined : stripPreviewCookie(request.headers.get("cookie"));
		if (cookies) headers.cookie = cookies;
		// Nossos (não os do cliente): o projeto sabe o endereço público, embora o Host seja o IP do container.
		headers["x-forwarded-host"] = publicHost;
		headers["x-forwarded-proto"] = new URL(publicOrigin).protocol.slice(0, -1);
		return new Promise<Response>((resolve) => {
			const upstream = http.request(
				// Sem pool de conexões: dev servers fecham sockets ociosos em poucos segundos e o reuso viraria ECONNRESET.
				{ host: target.host, port: target.port, method: request.method, path: upstreamPath, headers, timeout: UPSTREAM_IDLE_MS, agent: false },
				(res) => {
					const out = new Headers();
					let blockedRedirect = false;
					for (const [key, value] of Object.entries(res.headers)) {
						if (HOP_BY_HOP.has(key) || value === undefined) continue;
						for (const v of Array.isArray(value) ? value : [value]) {
							// Modo básico: o que o projeto manda e compete com a nossa política (ou afeta o Atlas inteiro) é descartado; o resto passa.
							if (basicPrefix && (BASIC_DROP.has(key) || key.startsWith("access-control-"))) continue;
							if (key === "set-cookie") {
								const rewritten = rewriteUpstreamSetCookie(v);
								if (rewritten) out.append(key, rewritten);
							} else if (basicPrefix && (key === "location" || key === "content-location")) {
								const rewritten = rewriteLocationIntoPrefix(v, target.host, publicOrigin, basicPrefix, basicPath);
								if (rewritten !== null) out.append(key, rewritten);
								else if (key === "location") blockedRedirect = true;
							} else if (basicPrefix && key === "refresh") {
								// Refresh para fora da prévia (ou ilegível) some: a página só não recarrega.
								const target2 = /url\s*=\s*(\S+)/i.exec(v)?.[1];
								const rewritten = target2 === undefined ? v : rewriteLocationIntoPrefix(target2, target.host, publicOrigin, basicPrefix, basicPath);
								if (rewritten !== null) out.append(key, target2 === undefined ? v : v.replace(target2, rewritten));
							}
							else if (key === "location" || key === "content-location") out.append(key, rewriteToPublicOrigin(v, target.host, publicOrigin));
							else if (key === "refresh") out.append(key, rewriteRefresh(v, target.host, publicOrigin));
							else if (key === "access-control-allow-origin") out.append(key, rewriteToPublicOrigin(v, target.host, publicOrigin));
							else out.append(key, v);
						}
					}
					for (const [key, value] of Object.entries(SECURITY_HEADERS)) out.set(key, value);
					if (basicPrefix) applyBasicHeaders(out, request.headers);
					if (!out.has("cache-control")) out.set("Cache-Control", "no-store");
					if (blockedRedirect) {
						res.resume();
						return resolve(basicText(502, "Redirecionamento para fora da prévia bloqueado."));
					}
					const status = res.statusCode ?? 502;
					const noBody = request.method === "HEAD" || status === 204 || status === 304;
					resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
					if (noBody) res.resume();
				},
			);
			upstream.on("timeout", () => upstream.destroy(new Error("preview upstream timeout")));
			upstream.on("error", () => resolve((basicPrefix ? basicText : text)(502, "O projeto não respondeu. Peça ao assistente para conferir se o servidor está rodando.")));
			request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });
			if (request.body && request.method !== "GET" && request.method !== "HEAD") Readable.fromWeb(request.body as never).pipe(upstream);
			else upstream.end();
		});
	}

	// ---- WebSocket (HMR do Vite etc.) --------------------------------------

	function claimsUpgrade(req: http.IncomingMessage): boolean {
		return previewIdFromHost(req.headers.host, deps.config?.baseDomain ?? null) !== null || isBasicUpgrade(req);
	}

	/** Modo básico: o caminho `/v1/previews/<id>/p/...` é nosso (e o WebSocket é recusado, ver `handleUpgrade`). */
	function isBasicUpgrade(req: http.IncomingMessage): boolean {
		if (!deps.config || previewMode(deps.config) !== "basic") return false;
		return parsePreviewBasicPath(new URL(req.url ?? "/", "http://x").pathname) !== null;
	}

	function reject(socket: Duplex, status: number, label: string): void {
		if (socket.writable) socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		socket.destroy();
	}

	async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		socket.on("error", () => socket.destroy());
		try {
			// Modo básico: sem HMR. O WebSocket não passa por CORS e a origem do handshake seria "null" (toda página em sandbox, de
			// qualquer site, também envia "null"), então não há como distinguir a prévia de um site hostil que use o cookie SameSite=None.
			// Recusar é o lado seguro: a página precisa ser recarregada (ver docs/features/previa-privada.md).
			if (isBasicUpgrade(req)) return reject(socket, 403, "Forbidden");
			const id = previewIdFromHost(req.headers.host, deps.config?.baseDomain ?? null);
			if (!id) return reject(socket, 404, "Not Found");
			// Impede WebSocket vindo de outro site usando o cookie da prévia (CSWSH).
			const origin = req.headers.origin;
			if (origin) {
				let originHost: string | null = null;
				try { originHost = new URL(origin).host; } catch { /* inválida */ }
				if (originHost !== req.headers.host) return reject(socket, 403, "Forbidden");
			}
			const auth = await authenticate(id, req.headers.cookie);
			if ("response" in auth) return reject(socket, auth.response.status, "Unauthorized");
			noteActivity(id);
			const { target } = auth;
			const config = deps.config!;
			const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined || key === "host" || key === "authorization" || key === "origin" || key === "cookie" || key === "forwarded" || key === "x-real-ip" || key.startsWith("x-forwarded-")) continue;
				for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
			}
			const cookies = stripPreviewCookie(req.headers.cookie);
			if (cookies) lines.push(`cookie: ${cookies}`);
			lines.push(`x-forwarded-host: ${req.headers.host ?? ""}`, `x-forwarded-proto: ${config.scheme}`);
			const upstream = net.connect({ host: target.host, port: target.port });
			upstream.setTimeout(15_000, () => upstream.destroy());
			let connected = false;
			upstream.on("error", () => (connected ? socket.destroy() : reject(socket, 502, "Bad Gateway")));
			upstream.once("connect", () => {
				connected = true;
				upstream.setTimeout(0);
				upstream.setKeepAlive(true, 20_000);
				(socket as net.Socket).setKeepAlive?.(true, 20_000);
				upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			socket.on("close", () => upstream.destroy());
			upstream.on("close", () => socket.destroy());
			track(id, { userId: target.userId, socket, upstream, cookieExpiresAt: auth.cookieExpiresAt }, target.expiresAt);
			// Servidores HTTP aceitam meia-conexão: um FIN de um lado sem o outro fechar deixaria o par aberto para sempre.
			const teardownSoon = () => setTimeout(() => { socket.destroy(); upstream.destroy(); }, WS_HALF_CLOSE_GRACE_MS).unref();
			socket.once("end", teardownSoon);
			upstream.once("end", teardownSoon);
		} catch {
			reject(socket, 500, "Internal Server Error");
		}
	}

	return { handleRequest, handleBasicRequest, claimsUpgrade, handleUpgrade, invalidate, sweep };
}

// ---- Rota no domínio do Atlas: gera o link de entrada ----------------------

/** `GET /v1/previews/:id/open` (requireUser): dono → token curto → redirect ao domínio da prévia. */
export function createPreviewOpenRoutes(deps: Pick<PreviewDeps, "config" | "getOwnedSession" | "now">) {
	const app = new Hono<AuthEnv>();
	app.get("/v1/previews/:id/open", async (c) => {
		const config = deps.config;
		if (!config) return c.json({ error: "Preview not configured" }, 404);
		const { userId } = scopeFor(c.get("session"));
		const id = c.req.param("id");
		const row = await deps.getOwnedSession(id, userId);
		const preview = row?.preview;
		const now = deps.now?.() ?? Date.now();
		// Outro dono, sem prévia ou vencida: 404 igual (não revela que existe).
		if (!row || !preview || row.status !== "RUNNING" || Date.parse(preview.expiresAt) <= now) return c.json({ error: "Not found" }, 404);
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		if (!config.baseDomain) {
			// Modo básico: o login do Atlas já provou o dono; o segredo da prévia (`cap`, só no banco e aqui) vai no caminho.
			// Prévia sem `cap` (de antes do modo básico, ou de outro modo) não abre: 404 igual.
			if (!preview.cap || !previewCapIsLive(preview.capIssuedAt, now)) return c.json({ error: "Not found" }, 404);
			const entry = normalizePreviewPath(preview.path) ?? "/";
			return c.redirect(`${previewBasicPrefix(row.id, preview.cap)}${entry.slice(1)}`, 302);
		}
		const token = signPreviewToken("open", { previewId: row.id, userId }, config.secret, PREVIEW_OPEN_TOKEN_TTL_MS, now);
		const origin = previewOrigin({ scheme: config.scheme, baseDomain: config.baseDomain, id: row.id });
		return c.redirect(`${origin}${PREVIEW_AUTH_PATH}?t=${token}`, 302);
	});
	return app;
}

/**
 * Modo básico: `/v1/previews/:id/p/*`. Pública no `requireUser` (allowlist `isPublicV1Request`) porque a autenticação é o `cap` no
 * caminho, conferido no serviço; o cookie de login do Atlas nunca é exigido nem repassado. Sem o modo básico responde 404.
 */
export function createPreviewBasicRoutes(service: Pick<ReturnType<typeof createPreviewService>, "handleBasicRequest">) {
	const app = new Hono<AuthEnv>();
	app.all("/v1/previews/:id/p", (c) => service.handleBasicRequest(c.req.raw));
	app.all("/v1/previews/:id/p/*", (c) => service.handleBasicRequest(c.req.raw));
	return app;
}

/**
 * Ouvinte único de `upgrade` do servidor: Host de prévia vai ao proxy da prévia; o resto, ao viewer noVNC (se ligado)
 * ou recebe um 404 limpo (sem ouvinte o Node trataria como requisição normal; com ouvinte, calar o socket seria pior).
 */
export function createUpgradeDispatcher(input: {
	preview: Pick<ReturnType<typeof createPreviewService>, "claimsUpgrade" | "handleUpgrade">;
	viewer?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}) {
	return (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (input.preview.claimsUpgrade(req)) void input.preview.handleUpgrade(req, socket, head);
		else if (input.viewer) void input.viewer(req, socket, head);
		else {
			if (socket.writable) socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
		}
	};
}
