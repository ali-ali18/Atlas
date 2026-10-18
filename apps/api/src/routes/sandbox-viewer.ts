import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import type { SandboxManager } from "@workspace/sandbox";

/**
 * Proxy autenticado do noVNC da sandbox (modo `SANDBOX_VIEWER_MODE=proxy`).
 *
 * - HTTP (`vnc.html`, JS, CSS): rota Hono em `sandbox.ts`, autenticada pelo
 *   cookie de sessão (mesma origem) e com posse checada pelo middleware.
 * - WebSocket (`.../viewer/websockify`): `server.on("upgrade")` — o Hono não
 *   enxerga upgrades. Autentica por token HMAC curto (`?t=`) OU pelo cookie.
 */

export const VIEWER_TOKEN_TTL_MS = 10 * 60_000;
const WS_PATH_RE = /^\/v1\/sandbox\/sessions\/([^/]+)\/viewer\/websockify$/;

// ---- Token ---------------------------------------------------------------

function sign(payload: string, secret: string): string {
	return createHmac("sha256", `atlas-sandbox-viewer:${secret}`).update(payload).digest("base64url");
}

export function signViewerToken(
	input: { sessionId: string; userId: string },
	secret: string,
	now = Date.now(),
	ttlMs = VIEWER_TOKEN_TTL_MS,
): string {
	const payload = Buffer.from(JSON.stringify({ s: input.sessionId, u: input.userId, e: now + ttlMs })).toString("base64url");
	return `${payload}.${sign(payload, secret)}`;
}

/** Devolve o userId se o token é válido, não expirou e é da sessão pedida. */
export function verifyViewerToken(
	token: string | null | undefined,
	sessionId: string,
	secret: string,
	now = Date.now(),
): string | null {
	if (!token || !secret) return null;
	const [payload, mac, extra] = token.split(".");
	if (!payload || !mac || extra !== undefined) return null;
	const expected = Buffer.from(sign(payload, secret));
	const given = Buffer.from(mac);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; u?: unknown; e?: unknown };
		if (typeof data.s !== "string" || typeof data.u !== "string" || typeof data.e !== "number") return null;
		if (data.s !== sessionId || data.e <= now) return null;
		return data.u;
	} catch {
		return null;
	}
}

/** Acrescenta `?t=` ao `path=` (websockify) da URL do viewer em modo proxy. */
export function withViewerToken(viewerUrl: string, token: string): string {
	if (!viewerUrl.startsWith("/v1/sandbox/")) return viewerUrl;
	const url = new URL(viewerUrl, "http://viewer.invalid");
	const path = url.searchParams.get("path");
	if (!path) return viewerUrl;
	url.searchParams.set("path", `${path}?t=${token}`);
	return `${url.pathname}${url.search}`;
}

// ---- Posse ---------------------------------------------------------------

export type ViewerOwnershipDeps = {
	managerForUser: (userId: string) => SandboxManager;
	ownedConversation: (conversationId: string, userId: string) => Promise<unknown>;
};

/** Mesma regra do middleware de `/v1/sandbox/*`. */
export async function ownsSession(deps: ViewerOwnershipDeps, userId: string, sessionId: string): Promise<boolean> {
	const session = await deps.managerForUser(userId).getOwnedSessionMetadata(sessionId);
	if (!session) return false;
	if (session.conversationId && !(await deps.ownedConversation(session.conversationId, userId))) return false;
	return true;
}

// ---- HTTP ----------------------------------------------------------------

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);
const REQUEST_STRIP = new Set([...HOP_BY_HOP, "cookie", "authorization", "host", "origin", "referer", "accept-encoding"]);

export type ViewerTarget = { host: string; port: number; tls: boolean };

export async function proxyViewerHttp(request: Request, target: ViewerTarget, upstreamPath: string): Promise<Response> {
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		if (!REQUEST_STRIP.has(key)) headers[key] = value;
	});
	const lib = target.tls ? https : http;
	return new Promise<Response>((resolve) => {
		const upstream = lib.request(
			{ host: target.host, port: target.port, method: request.method, path: upstreamPath, headers, timeout: 15_000, ...(target.tls ? { rejectUnauthorized: false } : {}) },
			(res) => {
				const out = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (HOP_BY_HOP.has(key) || value === undefined) continue;
					for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
				}
				out.set("X-Content-Type-Options", "nosniff");
				out.set("Cache-Control", "private, no-store");
				const status = res.statusCode ?? 502;
				const noBody = request.method === "HEAD" || status === 204 || status === 304;
				resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
				if (noBody) res.resume();
			},
		);
		upstream.on("timeout", () => upstream.destroy(new Error("viewer upstream timeout")));
		upstream.on("error", (error) => { console.warn(`[sandbox-viewer] http upstream ${target.host}:${target.port} falhou: ${error.message}`); resolve(new Response(JSON.stringify({ error: "Viewer unavailable" }), { status: 502, headers: { "Content-Type": "application/json" } })); });
		request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });
		upstream.end();
	});
}

// ---- WebSocket -----------------------------------------------------------

export type ViewerUpgradeDeps = ViewerOwnershipDeps & {
	secret: string;
	/** Usuário da sessão por cookie (fallback quando não há token). */
	userFromRequest: (headers: Headers) => Promise<string | null>;
	now?: () => number;
};

function reject(socket: Duplex, status: number, text: string, reason?: string): void {
	// Diagnóstico de produção (tela preta): sem token/cookie/URL no log.
	console.warn(`[sandbox-viewer] websocket recusado ${status}${reason ? `: ${reason}` : ""}`);
	if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

function sameOrigin(req: http.IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

export function createViewerUpgradeHandler(deps: ViewerUpgradeDeps) {
	return async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		socket.on("error", () => socket.destroy());
		try {
			const url = new URL(req.url ?? "/", "http://viewer.invalid");
			const match = WS_PATH_RE.exec(url.pathname);
			if (!match) return reject(socket, 404, "Not Found", "caminho não é de viewer");
			const sessionId = decodeURIComponent(match[1]!);
			// Evita WebSocket entre sites autenticado só por cookie.
			if (!sameOrigin(req)) return reject(socket, 403, "Forbidden", `origin ${String(req.headers.origin)} ≠ host ${String(req.headers.host)}`);

			let userId = verifyViewerToken(url.searchParams.get("t"), sessionId, deps.secret, deps.now?.());
			if (!userId) {
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
				userId = await deps.userFromRequest(headers);
			}
			if (!userId) return reject(socket, 401, "Unauthorized", `sem login (token ${url.searchParams.get("t") ? "inválido/expirado" : "ausente"}, cookie ${req.headers.cookie ? "presente" : "ausente"})`);
			if (!(await ownsSession(deps, userId, sessionId))) return reject(socket, 404, "Not Found", "sessão não é deste usuário ou não existe");

			const target = await deps.managerForUser(userId).resolveViewerTarget(sessionId);
			if (!target) return reject(socket, 404, "Not Found", "VM sem destino (parada ou sem IP/porta)");

			url.searchParams.delete("t");
			const query = url.searchParams.toString();
			const lines = [`GET /websockify${query ? `?${query}` : ""} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined || ["host", "cookie", "authorization", "origin"].includes(key)) continue;
				for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
			}
			const upstream: net.Socket = target.tls
				? tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false })
				: net.connect({ host: target.host, port: target.port });
			upstream.setTimeout(15_000, () => upstream.destroy());
			let connected = false;
			upstream.on("error", (error) => {
				console.warn(`[sandbox-viewer] websocket upstream ${target.host}:${target.port} falhou: ${error.message}`);
				if (connected) socket.destroy();
				else reject(socket, 502, "Bad Gateway");
			});
			upstream.once(target.tls ? "secureConnect" : "connect", () => {
				console.log(`[sandbox-viewer] websocket conectado à VM ${target.host}:${target.port}`);
				connected = true;
				upstream.setTimeout(0);
				upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			socket.on("close", () => upstream.destroy());
			upstream.on("close", () => socket.destroy());
		} catch {
			reject(socket, 500, "Internal Server Error");
		}
	};
}
