import { Hono } from "hono";
import { getOwnedConversation } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import type {
	CreateSandboxSessionBody,
	SandboxClickBody,
	SandboxKeyBody,
	SandboxNavigateBody,
	SandboxScrollBody,
	SandboxSessionResponse,
	SandboxTypeBody,
} from "@workspace/shared";
import {
	createSandboxManager,
	SandboxDockerUnavailableError,
	SandboxControlError,
	type SandboxManager,
	type SandboxRuntimeConfig,
} from "@workspace/sandbox";
import { ownsSession, proxyViewerHttp, readViewerToken, safeViewerRest, signViewerToken, withViewerToken } from "./sandbox-viewer.js";

function toErrorResult(
	error: unknown,
	fallback: string,
): { status: 400 | 404 | 500 | 501 | 503; message: string } {
	if (error instanceof SandboxControlError) {
		const status =
			error.status >= 400 && error.status < 600
				? (error.status as 400 | 404 | 500 | 501 | 503)
				: 500;
		return { status, message: error.message };
	}
	if (error instanceof Error && error.message.includes("not found")) {
		return { status: 404, message: error.message };
	}
	console.error(fallback, error);
	return { status: 500, message: fallback };
}

function parseClickBody(body: unknown): SandboxClickBody | null {
	if (typeof body !== "object" || body === null) return null;
	const x = Number((body as { x?: unknown }).x);
	const y = Number((body as { y?: unknown }).y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

function parseTypeBody(body: unknown): SandboxTypeBody | null {
	if (typeof body !== "object" || body === null) return null;
	const text = (body as { text?: unknown }).text;
	if (typeof text !== "string") return null;
	return { text };
}

function parseKeyBody(body: unknown): SandboxKeyBody | null {
	if (typeof body !== "object" || body === null) return null;
	const combo = (body as { combo?: unknown }).combo;
	if (typeof combo !== "string" || combo.trim().length === 0) return null;
	return { combo: combo.trim() };
}

function parseScrollBody(body: unknown): SandboxScrollBody | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as { deltaX?: unknown; deltaY?: unknown };
	const deltaX = raw.deltaX === undefined ? 0 : Number(raw.deltaX);
	const deltaY = raw.deltaY === undefined ? 0 : Number(raw.deltaY);
	if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
	return { deltaX, deltaY };
}

function parseCreateBody(body: unknown): CreateSandboxSessionBody {
	if (typeof body !== "object" || body === null) {
		return {};
	}
	const conversationId = (body as { conversationId?: unknown }).conversationId;
	if (conversationId === undefined) {
		return {};
	}
	if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
		throw new Error("Invalid conversationId");
	}
	return { conversationId: conversationId.trim() };
}

function parseNavigateBody(body: unknown): SandboxNavigateBody | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const url = (body as { url?: unknown }).url;
	if (typeof url !== "string" || url.trim().length === 0) {
		return null;
	}
	return { url: url.trim() };
}

const VIEWER_TOKEN_PREFIX = "/v1/sandbox/vt/";
const VIEWER_SANDBOX_CSP = "sandbox allow-scripts; frame-ancestors 'none'";

type SandboxEnv = { Variables: AuthEnv["Variables"] & { sandboxManager: SandboxManager } };
export function createSandboxRoutes(sandboxConfig: SandboxRuntimeConfig, deps: {
	managerForUser?: (userId: string) => SandboxManager;
	ownedConversation?: typeof getOwnedConversation;
	/** Segredo do token do viewer (padrão: BETTER_AUTH_SECRET). */
	viewerSecret?: string;
} = {}) {
	const app = new Hono<SandboxEnv>();
	const ownedConversation = deps.ownedConversation ?? getOwnedConversation;
	// Em modo proxy, embute no `path=` do noVNC um token curto p/ o WebSocket
	// (o cookie também vale; o token cobre clientes sem cookie no upgrade).
	const withToken = <T extends { sessionId: string; viewerUrl: string }>(session: T, userId: string): T => {
		const secret = deps.viewerSecret ?? process.env.BETTER_AUTH_SECRET ?? "";
		if (sandboxConfig.viewerMode !== "proxy" || !secret) return session;
		return { ...session, viewerUrl: withViewerToken(session.viewerUrl, signViewerToken({ sessionId: session.sessionId, userId }, secret)) };
	};
	// Só nas rotas da sandbox: com "*" este middleware rodava em todo /v1/*
	// (o app é montado em "/"), inclusive no webhook público do GitHub, que
	// não tem sessão — `scopeFor(undefined)` estourava e o hook dava 500.
	app.use("/v1/sandbox/*", async (c, next) => {
		// `/v1/sandbox/vt/<token>/*` é pública (WebView sem cookie): a rota faz a própria autorização pelo token + posse.
		if (c.req.path.startsWith(VIEWER_TOKEN_PREFIX)) return next();
		const { userId } = scopeFor(c.get("session"));
		const manager = deps.managerForUser?.(userId) ?? createSandboxManager(sandboxConfig, userId);
		c.set("sandboxManager", manager);
		const id = /^\/v1\/sandbox\/sessions\/([^/]+)/.exec(c.req.path)?.[1];
		if (id) {
			const session = await manager.getOwnedSessionMetadata(decodeURIComponent(id));
			if (!session || (session.conversationId && !(await ownedConversation(session.conversationId, userId)))) {
				return c.json({ error: "Session not found" }, 404);
			}
		}
		await next();
	});

	// Retorna o sandbox ativo da conversa (religa se parado) sem criar — usado no
	// reload do front pra reabrir o viewer em vez de iniciar um novo.
	app.get("/v1/sandbox/sessions", async (c) => {
		const manager = c.get("sandboxManager");
		const conversationId = c.req.query("conversationId")?.trim();
		if (!conversationId) {
			return c.json({ session: null });
		}
		if (!(await ownedConversation(conversationId, scopeFor(c.get("session")).userId))) return c.json({ error: "Conversation not found" }, 404);
		try {
			const session =
				await manager.getSessionForConversation(conversationId, { wake: c.req.query("wake") !== "0" });
			return c.json({ session: session ? withToken(session, scopeFor(c.get("session")).userId) : session });
		} catch (error) {
			console.error("get active sandbox session failed", error);
			return c.json({ session: null });
		}
	});

	// "Limpar sessão do navegador": apaga cookies/logins da conversa (volume do perfil
	// do Chrome) e derruba a VM; ela volta limpa no próximo uso. Arquivos de trabalho ficam.
	app.delete("/v1/sandbox/browser-profile", async (c) => {
		const manager = c.get("sandboxManager");
		const conversationId = c.req.query("conversationId")?.trim();
		if (!conversationId) return c.json({ error: "conversationId is required" }, 400);
		if (!(await ownedConversation(conversationId, scopeFor(c.get("session")).userId))) return c.json({ error: "Conversation not found" }, 404);
		try {
			const result = await manager.clearBrowserProfile(conversationId);
			return c.json({ ok: true, ...result });
		} catch (error) {
			console.error("clear sandbox browser profile failed", error);
			return c.json({ error: "Failed to clear browser profile" }, 500);
		}
	});

	app.post("/v1/sandbox/sessions", async (c) => {
		const manager = c.get("sandboxManager");
		let body: CreateSandboxSessionBody = {};
		try {
			const raw = await c.req.json().catch(() => ({}));
			body = parseCreateBody(raw);
		} catch {
			return c.json({ error: "Invalid request body" }, 400);
		}

		if (body.conversationId && !(await ownedConversation(body.conversationId, scopeFor(c.get("session")).userId))) return c.json({ error: "Conversation not found" }, 404);
		try {
			const session = await manager.resolveSession(body.conversationId);
			return c.json(withToken(session, scopeFor(c.get("session")).userId) satisfies SandboxSessionResponse, 201);
		} catch (error) {
			if (error instanceof SandboxDockerUnavailableError) {
				const message =
					error.message || "Failed to start sandbox container";
				// Detalhe técnico só no log (o front mostra mensagem em português).
				console.error(`sandbox start failed after retries conversation=${body.conversationId ?? "-"}: ${message}`);
				// Código estável para o front diagnosticar sem parsear texto:
				// timeout de boot vs. infra (imagem ausente, portas, Docker).
				const code = message.includes("did not become ready")
					? "sandbox_start_timeout"
					: message.includes("No such image") ||
						  message.includes("published sandbox ports")
						? "sandbox_infra"
						: "sandbox_unavailable";
				return c.json({ error: message, code }, 503);
			}
			console.error("create sandbox session failed", error);
			return c.json({ error: "Failed to create sandbox session" }, 500);
		}
	});

	app.get("/v1/sandbox/sessions/:id", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		try {
			const session = await manager.getSession(id);
			if (!session) {
				return c.json({ error: "Session not found" }, 404);
			}
			return c.json(withToken(session, scopeFor(c.get("session")).userId));
		} catch (error) {
			console.error("get sandbox session failed", error);
			return c.json({ error: "Failed to get sandbox session" }, 500);
		}
	});

	// Proxy HTTP do noVNC (vnc.html, JS, CSS). A posse já foi checada pelo
	// middleware de /v1/sandbox/*; o WebSocket é tratado em `sandbox-viewer.ts`.
	app.on(["GET", "HEAD"], "/v1/sandbox/sessions/:id/viewer/*", async (c) => {
		const id = decodeURIComponent(c.req.param("id"));
		const prefix = `/v1/sandbox/sessions/${c.req.param("id")}/viewer/`;
		const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
		if (rest.split("/").some((part) => part === ".." || part === ".")) return c.json({ error: "Not found" }, 404);
		let target;
		try {
			target = await c.get("sandboxManager").resolveViewerTarget(id);
		} catch (error) {
			console.error("resolve viewer target failed", error);
			return c.json({ error: "Viewer unavailable" }, 502);
		}
		if (!target) return c.json({ error: "Session not found" }, 404);
		const search = new URL(c.req.url).search;
		return proxyViewerHttp(c.req.raw, target, `/${rest || "vnc.html"}${search}`);
	});

	// Link do viewer para clientes sem cookie (app mobile em WebView). O token vai no CAMINHO (não na query) porque
	// os assets do noVNC (JS, CSS, imagens) são URLs relativas à página: só o caminho chega a todos eles sem cookie.
	// O `path=` do WebSocket segue o mesmo formato de `viewerUrl`, com `?t=` (o upgrade também aceita o token).
	// A posse da sessão já foi checada pelo middleware (404 para outro dono).
	app.get("/v1/sandbox/sessions/:id/viewer-link", (c) => {
		const secret = deps.viewerSecret ?? process.env.BETTER_AUTH_SECRET ?? "";
		if (sandboxConfig.viewerMode !== "proxy" || !secret) return c.json({ error: "Viewer link unavailable" }, 409);
		const id = decodeURIComponent(c.req.param("id"));
		const userId = scopeFor(c.get("session")).userId;
		// Dois tokens com propósitos distintos: o do caminho (HTTP, vai para log de acesso) não abre o WebSocket.
		const token = signViewerToken({ sessionId: id, userId, purpose: "vt" }, secret);
		const wsToken = signViewerToken({ sessionId: id, userId, purpose: "ws" }, secret);
		const params = new URLSearchParams({
			autoconnect: "1",
			reconnect: "true",
			resize: "scale",
			path: `v1/sandbox/sessions/${encodeURIComponent(id)}/viewer/websockify?t=${wsToken}`,
		});
		c.header("Cache-Control", "private, no-store");
		c.header("Referrer-Policy", "no-referrer");
		return c.json({ url: `${VIEWER_TOKEN_PREFIX}${token}/vnc.html?${params.toString()}` });
	});

	// Proxy HTTP do noVNC autorizado SÓ pelo token no caminho (sem cookie). A posse é conferida com o userId DO TOKEN,
	// igual ao middleware de /v1/sandbox/*. Falha de posse = 404 igual para tudo; token inválido/expirado = 401 sem
	// dizer qual. O token nunca vai para log nem para mensagem de erro. O token vale 10 min: depois disso o noVNC
	// (reconnect) recebe 401 em loop e recarregar a WebView falha (no-store); o app deve pedir `viewer-link` novo antes
	// de vencer ou quando a conexão cair. Nesses 10 min quem tem o link CONTROLA a VM.
	app.on(["GET", "HEAD"], "/v1/sandbox/vt/:token/*", async (c) => {
		const noReferrer = { "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" };
		const rawToken = c.req.param("token");
		const secret = deps.viewerSecret ?? process.env.BETTER_AUTH_SECRET ?? "";
		const claims = sandboxConfig.viewerMode === "proxy" ? readViewerToken(rawToken, secret) : null;
		if (!claims) return c.json({ error: "Unauthorized" }, 401, noReferrer);
		const prefix = `${VIEWER_TOKEN_PREFIX}${rawToken}/`;
		const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
		if (safeViewerRest(rest) === null) return c.json({ error: "Not found" }, 404, noReferrer);
		const { sessionId, userId } = claims;
		const manager = deps.managerForUser?.(userId) ?? createSandboxManager(sandboxConfig, userId);
		let target;
		try {
			const owned = await ownsSession({ managerForUser: () => manager, ownedConversation }, userId, sessionId);
			if (!owned) return c.json({ error: "Session not found" }, 404, noReferrer);
			target = await manager.resolveViewerTarget(sessionId);
		} catch {
			console.error("viewer token: falha ao resolver a sessão");
			return c.json({ error: "Viewer unavailable" }, 502, noReferrer);
		}
		if (!target) return c.json({ error: "Session not found" }, 404, noReferrer);
		const search = new URL(c.req.url).search;
		const response = await proxyViewerHttp(c.req.raw, target, `/${rest || "vnc.html"}${search}`);
		response.headers.set("Referrer-Policy", "no-referrer");
		// A VM é código do dono, servido na origem da API (que tem o cookie de login de quem abrir o link): CSP sandbox SEM
		// allow-same-origin joga o documento numa origem opaca (sem cookie nem storage da API), como em routes/previews.ts.
		response.headers.set("Content-Security-Policy", VIEWER_SANDBOX_CSP);
		return response;
	});

	// "Desligar computador": para a VM com graça (Chrome fecha direito) e mantém container,
	// perfil e login para quando ela for ligada de novo. Diferente do DELETE, que remove o container.
	app.post("/v1/sandbox/sessions/:id/stop", async (c) => {
		const manager = c.get("sandboxManager");
		try {
			const stopped = await manager.stopSession(c.req.param("id"));
			if (!stopped) return c.json({ error: "Session not found" }, 404);
			return c.json({ ok: true });
		} catch (error) {
			console.error("stop sandbox session failed", error);
			return c.json({ error: "Failed to stop sandbox session" }, 500);
		}
	});

	app.delete("/v1/sandbox/sessions/:id", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		try {
			const removed = await manager.destroySession(id);
			if (!removed) {
				return c.json({ error: "Session not found" }, 404);
			}
			return c.json({ ok: true });
		} catch (error) {
			console.error("destroy sandbox session failed", error);
			return c.json({ error: "Failed to destroy sandbox session" }, 500);
		}
	});

	app.post("/v1/sandbox/sessions/:id/navigate", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		const raw = await c.req.json().catch(() => null);
		const body = parseNavigateBody(raw);
		if (!body) {
			return c.json({ error: "url is required" }, 400);
		}

		try {
			const result = await manager.execNavigate(id, body.url);
			return c.json(result);
		} catch (error) {
			if (error instanceof SandboxControlError) {
				const status =
					error.status === 501 ? 501 : error.status >= 400 && error.status < 600
						? (error.status as 400 | 404 | 500 | 503)
						: 500;
				return c.json({ error: error.message }, status);
			}
			if (error instanceof Error && error.message.includes("not found")) {
				return c.json({ error: error.message }, 404);
			}
			console.error("sandbox navigate failed", error);
			return c.json({ error: "Navigate failed" }, 500);
		}
	});

	app.get("/v1/sandbox/sessions/:id/screenshot", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		try {
			const png = await manager.execScreenshot(id);
			return new Response(new Uint8Array(png), {
				status: 200,
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "no-store",
				},
			});
		} catch (error) {
			if (error instanceof SandboxControlError) {
				const status =
					error.status === 501 ? 501 : error.status >= 400 && error.status < 600
						? (error.status as 400 | 404 | 500 | 503)
						: 500;
				return c.json({ error: error.message }, status);
			}
			if (error instanceof Error && error.message.includes("not found")) {
				return c.json({ error: error.message }, 404);
			}
			console.error("sandbox screenshot failed", error);
			return c.json({ error: "Screenshot failed" }, 500);
		}
	});

	app.get("/v1/sandbox/sessions/:id/screen", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		try {
			const screen = await manager.execScreen(id);
			return c.json(screen);
		} catch (error) {
			const result = toErrorResult(error, "Screen geometry failed");
			return c.json({ error: result.message }, result.status);
		}
	});

	app.post("/v1/sandbox/sessions/:id/click", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		const raw = await c.req.json().catch(() => null);
		const body = parseClickBody(raw);
		if (!body) {
			return c.json({ error: "x and y are required" }, 400);
		}
		try {
			await manager.execClick(id, body.x, body.y);
			return c.json({ ok: true });
		} catch (error) {
			const result = toErrorResult(error, "Click failed");
			return c.json({ error: result.message }, result.status);
		}
	});

	app.post("/v1/sandbox/sessions/:id/type", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		const raw = await c.req.json().catch(() => null);
		const body = parseTypeBody(raw);
		if (!body) {
			return c.json({ error: "text is required" }, 400);
		}
		try {
			await manager.execType(id, body.text);
			return c.json({ ok: true });
		} catch (error) {
			const result = toErrorResult(error, "Type failed");
			return c.json({ error: result.message }, result.status);
		}
	});

	app.post("/v1/sandbox/sessions/:id/key", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		const raw = await c.req.json().catch(() => null);
		const body = parseKeyBody(raw);
		if (!body) {
			return c.json({ error: "combo is required" }, 400);
		}
		try {
			await manager.execKey(id, body.combo);
			return c.json({ ok: true });
		} catch (error) {
			const result = toErrorResult(error, "Key failed");
			return c.json({ error: result.message }, result.status);
		}
	});

	app.post("/v1/sandbox/sessions/:id/scroll", async (c) => {
		const manager = c.get("sandboxManager");
		const id = c.req.param("id");
		const raw = await c.req.json().catch(() => null);
		const body = parseScrollBody(raw);
		if (!body) {
			return c.json({ error: "deltaX/deltaY must be numbers" }, 400);
		}
		try {
			await manager.execScroll(id, body.deltaX ?? 0, body.deltaY ?? 0);
			return c.json({ ok: true });
		} catch (error) {
			const result = toErrorResult(error, "Scroll failed");
			return c.json({ error: result.message }, result.status);
		}
	});

	return app;
}
