import { createServer, type Server } from "node:http";
import {
	chatgptAuthService,
	SiwcAuthError,
	type ChatgptAuthService,
} from "@workspace/agent-runtime";

/** Só identificadores curtos (`authorization_failed`, `invalid_token_response:scope`): nunca valores de token. */
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,40}(:[a-z0-9_]{1,40})?$/;

/** Callback separado: sem cookie, autenticado por state único + PKCE + OIDC do dono. */
export function createSiwcCallbackHandler(
	service: Pick<ChatgptAuthService, "callback">,
	env: NodeJS.ProcessEnv = process.env,
) {
	return async (request: Request): Promise<Response> => {
		const port = Number(env.ATLAS_SIWC_CALLBACK_PORT ?? 53682),
			expected = `127.0.0.1:${port}`;
		const url = new URL(request.url);
		const headers = {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		};
		// Sem sessão aqui: quem valida o plano e o dono é `service.callback` (state → userId).
		if (
			request.method !== "GET" ||
			url.pathname !== "/callback" ||
			url.host !== expected ||
			(request.headers.get("host") && request.headers.get("host") !== expected)
		)
			return new Response(null, { status: 404, headers });
		if (
			request.url.length > 8192 ||
			[...url.searchParams.keys()].some(
				(name) => url.searchParams.getAll(name).length !== 1,
			)
		)
			return new Response(null, { status: 400, headers });
		let status = "ok";
		let code: string | undefined;
		try {
			await service.callback(url.searchParams);
		} catch (error) {
			status = "error";
			if (error instanceof SiwcAuthError && SAFE_ERROR_CODE.test(error.code))
				code = error.code;
		}
		const target = new URL(env.ATLAS_URL ?? "http://localhost:3000");
		if (
			!["http:", "https:"].includes(target.protocol) ||
			target.username ||
			target.password
		)
			return new Response(null, { status: 503, headers });
		// Página de conexão do web (não a home): mostra o estado e fecha o popup.
		target.pathname = "/providers/callback";
		target.search = new URLSearchParams({
			provider: "chatgpt",
			status,
			...(code ? { code } : {}),
		}).toString();
		target.hash = "";
		return new Response(null, {
			status: 302,
			headers: { ...headers, Location: target.href },
		});
	};
}
/** Sem uso por este tempo, o listener fecha sozinho (o login já terminou ou foi abandonado). */
const IDLE_CLOSE_MS = 10 * 60 * 1000;

/**
 * Listener do callback SIWC, sempre sob demanda: sobe no "Conectar", fecha ao
 * desligar o plano, após o callback concluído ou ocioso. Fábrica para testar
 * com porta efêmera e handler falso.
 */
export function createSiwcLoopback(
	options: {
		env?: NodeJS.ProcessEnv;
		handler?: (request: Request) => Promise<Response>;
		idleMs?: number;
	} = {},
) {
	const env = options.env ?? process.env;
	const idleMs = options.idleMs ?? IDLE_CLOSE_MS;
	let listener: Promise<Server> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	async function stop(): Promise<void> {
		clearIdle();
		const current = listener;
		listener = undefined;
		if (!current) return;
		let server: Server;
		try {
			server = await current;
		} catch {
			return;
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	function armIdle() {
		clearIdle();
		idleTimer = setTimeout(() => void stop(), idleMs);
		idleTimer.unref();
	}

	async function ensure(): Promise<void> {
		if (!listener) {
			listener = new Promise<Server>((resolve, reject) => {
				const port = Number(env.ATLAS_SIWC_CALLBACK_PORT ?? 53682),
					bind = env.ATLAS_SIWC_CALLBACK_BIND ?? "127.0.0.1";
				if (
					!Number.isInteger(port) ||
					port < 1024 ||
					port > 65535 ||
					!["127.0.0.1", "0.0.0.0"].includes(bind)
				)
					return reject(new SiwcAuthError("callback_unavailable"));
				const handler =
					options.handler ?? createSiwcCallbackHandler(chatgptAuthService, env);
				const server = createServer(async (req, res) => {
					try {
						const response = await handler(
							new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
								method: req.method,
								headers: { host: req.headers.host ?? "" },
							}),
						);
						res.writeHead(response.status, Object.fromEntries(response.headers));
						res.end();
						// Login concluído (redirect de volta ao app): a porta não precisa mais ficar aberta.
						if (response.status === 302) setImmediate(() => void stop());
					} catch {
						res.writeHead(503, { "Cache-Control": "no-store" }).end();
					}
				});
				server.once("error", () =>
					reject(new SiwcAuthError("callback_unavailable")),
				);
				server.listen(port, bind, () => {
					server.unref();
					resolve(server);
				});
			});
			listener.catch(() => {
				listener = undefined;
			});
		}
		await listener;
		armIdle();
	}

	return { ensure, stop, isListening: () => listener !== undefined };
}

const loopback = createSiwcLoopback();
/** Sobe sob demanda, no primeiro "Conectar" (a rota já exigiu dono e plano ligado). */
export const ensureSiwcLoopback = loopback.ensure;
/** Fecha o listener (plano desligado, login concluído ou ocioso); o próximo "Conectar" sobe de novo. */
export const stopSiwcLoopback = loopback.stop;
