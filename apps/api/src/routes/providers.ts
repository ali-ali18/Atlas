import { Hono } from "hono";
import {
	chatgptAuthService,
	envChatgptGate,
	SiwcAuthError,
	type ChatgptAuthService,
	type ChatgptGateResolver,
} from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { chatgptModelCatalog } from "../providers/model-catalog.js";
import { ensureSiwcLoopback } from "../providers/siwc-loopback.js";

/** Só identificadores curtos: nunca valores de token. */
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,40}(:[a-z0-9_]{1,40})?$/;

export function createProviderRoutes(
	service: ChatgptAuthService = chatgptAuthService,
	ensureCallback: () => Promise<void> = ensureSiwcLoopback,
	env: NodeJS.ProcessEnv = process.env,
	catalog: Pick<typeof chatgptModelCatalog, "list"> = chatgptModelCatalog,
	/** Plano ligado para o usuário da sessão (conta > env). Omitido = só o env. */
	gate: ChatgptGateResolver = envChatgptGate(env),
) {
	const app = new Hono<AuthEnv>();
	app.use("/v1/providers*", async (c, next) => {
		const session = c.get("session"),
			owner = env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
		if (!session || !owner || session.user.email.trim().toLowerCase() !== owner)
			return c.json({ error: "Não encontrado" }, 404);
		let plan;
		try {
			plan = await gate(scopeFor(session).userId);
		} catch {
			return c.json({ error: "Não encontrado" }, 404);
		}
		// Desligar o plano mantém a conexão: o dono que o desligou na UI ainda
		// pode desconectar e apagar os tokens. Env desligado nunca abre nada.
		const disconnecting = c.req.method === "DELETE" && c.req.path === "/v1/providers/chatgpt";
		if (!plan.enabled && !(disconnecting && plan.source === "user"))
			return c.json({ error: "Não encontrado" }, 404);
		await next();
	});
	const handleError = (error: unknown) => ({
		message:
			error instanceof SiwcAuthError
				? error.message
				: "Não foi possível conectar o ChatGPT",
		status:
			error instanceof SiwcAuthError && error.status === 404
				? (404 as const)
				: (503 as const),
	});
	app.get("/v1/providers", async (c) => {
		try {
			return c.json({
				providers: [await service.status(scopeFor(c.get("session")).userId)],
			});
		} catch (error) {
			const safe = handleError(error);
			return c.json({ error: safe.message }, safe.status);
		}
	});
	app.get("/v1/providers/chatgpt/models", async (c) => {
  try {
   return c.json(await catalog.list(scopeFor(c.get("session")).userId, c.req.query("selected")));
  } catch (error) {
   const safe = handleError(error);
   return c.json({ error: safe.message }, safe.status);
  }
 });
	app.post("/v1/providers/chatgpt/connect", async (c) => {
		try {
			await ensureCallback();
			return c.json(await service.connect(scopeFor(c.get("session")).userId));
		} catch (error) {
			const safe = handleError(error);
			return c.json({ error: safe.message }, safe.status);
		}
	});
	// Login por código de dispositivo (funciona com Atlas remoto): o código só pertence à sessão que o pediu.
	const deviceError = (error: unknown) => {
		if (error instanceof SiwcAuthError && error.status === 404)
			return { body: { error: "Não encontrado" }, status: 404 as const };
		const code =
			error instanceof SiwcAuthError && SAFE_ERROR_CODE.test(error.code) ? error.code : undefined;
		return {
			body: { error: "Não foi possível concluir o login do ChatGPT", ...(code ? { code } : {}) },
			status: (error instanceof SiwcAuthError && error.status === 400 ? 400 : 503) as 400 | 503,
		};
	};
	app.post("/v1/providers/chatgpt/device/start", async (c) => {
		try {
			return c.json(await service.startDeviceLogin(scopeFor(c.get("session")).userId));
		} catch (error) {
			const safe = deviceError(error);
			return c.json(safe.body, safe.status);
		}
	});
	app.post("/v1/providers/chatgpt/device/poll", async (c) => {
		try {
			return c.json(await service.pollDeviceLogin(scopeFor(c.get("session")).userId));
		} catch (error) {
			const safe = deviceError(error);
			return c.json(safe.body, safe.status);
		}
	});
	app.delete("/v1/providers/chatgpt", async (c) => {
		try {
			const result = await service.disconnect(
				scopeFor(c.get("session")).userId,
			);
			return c.json({ ok: true, ...result });
		} catch (error) {
			const safe = handleError(error);
			return c.json({ error: safe.message }, safe.status);
		}
	});
	return app;
}
