import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import type { DevSessionRecord } from "@workspace/db";
import {
	isPreviewPort,
	normalizePreviewBaseDomain,
	normalizePreviewPath,
	previewBaseDomainConflict,
	previewIdFromHost,
	previewOrigin,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Prévia privada do projeto web da sessão de código, servida numa ORIGEM SEPARADA do Atlas
 * (`https://<id>.<ATLAS_PREVIEW_BASE_DOMAIN>/`). O JavaScript do projeto é código do usuário/modelo:
 * na origem do Atlas ele alcançaria o cookie de login, então não existe plano B na mesma origem.
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
	baseDomain: string;
	scheme: "http" | "https";
	/** Origem do Atlas (`ATLAS_URL`): vai no link entregue ao usuário. */
	atlasUrl: string;
	secret: string;
};

/** `null` = prévia desligada (sem domínio-base ou sem segredo): nenhuma rota responde e a tool recusa. */
export function loadPreviewConfig(env: NodeJS.ProcessEnv = process.env): PreviewConfig | null {
	const baseDomain = normalizePreviewBaseDomain(env.ATLAS_PREVIEW_BASE_DOMAIN);
	const atlasUrl = env.ATLAS_URL?.trim().replace(/\/+$/, "");
	const secret = env.BETTER_AUTH_SECRET ?? "";
	if (!baseDomain || !atlasUrl || !secret) return null;
	if (previewConfigProblem(env)) return null;
	return { baseDomain, atlasUrl, secret, scheme: atlasUrl.startsWith("https://") ? "https" : "http" };
}

/** Por que a prévia ficou desligada apesar de `ATLAS_PREVIEW_BASE_DOMAIN` estar definida (para o log de boot); `null` = nada a avisar. */
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

type Target = { host: string; port: number; path: string; userId: string; expiresAt: number };

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);
const REQUEST_STRIP = new Set([...HOP_BY_HOP, "authorization", "host", "origin", "referer", "forwarded", "x-real-ip", "cookie"]);

const SECURITY_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Content-Type-Options": "nosniff",
};

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra } });
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
		return host ? { host, port: preview.port, path: normalizePreviewPath(preview.path) ?? "/", userId: row.userId, expiresAt } : null;
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
		if (!config || !id) return null;
		const url = new URL(request.url);

		if (url.pathname === PREVIEW_AUTH_PATH) return handleAuth(config, id, url);

		const auth = await authenticate(id, request.headers.get("cookie"));
		if ("response" in auth) return auth.response;
		noteActivity(id);
		return proxyHttp(request, auth.target, `${url.pathname}${url.search}`, previewOrigin({ scheme: config.scheme, baseDomain: config.baseDomain, id }), request.headers.get("host") ?? "");
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

	function proxyHttp(request: Request, target: Target, upstreamPath: string, publicOrigin: string, publicHost: string): Promise<Response> {
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			if (!REQUEST_STRIP.has(key) && !key.startsWith("x-forwarded-")) headers[key] = value;
		});
		const cookies = stripPreviewCookie(request.headers.get("cookie"));
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
					for (const [key, value] of Object.entries(res.headers)) {
						if (HOP_BY_HOP.has(key) || value === undefined) continue;
						for (const v of Array.isArray(value) ? value : [value]) {
							if (key === "set-cookie") {
								const rewritten = rewriteUpstreamSetCookie(v);
								if (rewritten) out.append(key, rewritten);
							} else if (key === "location" || key === "content-location") out.append(key, rewriteToPublicOrigin(v, target.host, publicOrigin));
							else if (key === "refresh") out.append(key, rewriteRefresh(v, target.host, publicOrigin));
							else if (key === "access-control-allow-origin") out.append(key, rewriteToPublicOrigin(v, target.host, publicOrigin));
							else out.append(key, v);
						}
					}
					for (const [key, value] of Object.entries(SECURITY_HEADERS)) out.set(key, value);
					if (!out.has("cache-control")) out.set("Cache-Control", "no-store");
					const status = res.statusCode ?? 502;
					const noBody = request.method === "HEAD" || status === 204 || status === 304;
					resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
					if (noBody) res.resume();
				},
			);
			upstream.on("timeout", () => upstream.destroy(new Error("preview upstream timeout")));
			upstream.on("error", () => resolve(text(502, "O projeto não respondeu. Peça ao assistente para conferir se o servidor está rodando.")));
			request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });
			if (request.body && request.method !== "GET" && request.method !== "HEAD") Readable.fromWeb(request.body as never).pipe(upstream);
			else upstream.end();
		});
	}

	// ---- WebSocket (HMR do Vite etc.) --------------------------------------

	function claimsUpgrade(req: http.IncomingMessage): boolean {
		return previewIdFromHost(req.headers.host, deps.config?.baseDomain ?? null) !== null;
	}

	function reject(socket: Duplex, status: number, label: string): void {
		if (socket.writable) socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		socket.destroy();
	}

	async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		socket.on("error", () => socket.destroy());
		try {
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

	return { handleRequest, claimsUpgrade, handleUpgrade, invalidate, sweep };
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
		const token = signPreviewToken("open", { previewId: row.id, userId }, config.secret, PREVIEW_OPEN_TOKEN_TTL_MS, now);
		const origin = previewOrigin({ scheme: config.scheme, baseDomain: config.baseDomain, id: row.id });
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		return c.redirect(`${origin}${PREVIEW_AUTH_PATH}?t=${token}`, 302);
	});
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
