import net from "node:net";
import type { ChatTool } from "@workspace/llm";
import type { DevClient, DevEndpoint } from "@workspace/sandbox";
import { isPreviewPort, normalizePreviewBaseDomain, previewBaseDomainConflict, previewBasicPrefix, normalizePreviewPath, PREVIEW_MAX_PORT, PREVIEW_MIN_PORT, PREVIEW_TTL_MS, type DevSessionPreview } from "@workspace/shared";

/**
 * Prévia privada: `preview_start` registra a porta de um servidor web que roda no container da sessão de
 * código e devolve o link que o DONO abre no navegador/celular; `preview_stop` encerra. O proxy fica na API
 * (origem separada, ver `apps/api/src/routes/previews.ts`); aqui só se valida a porta, se checa que o
 * servidor responde de fora do container e se grava a prévia na sessão.
 */

export const PREVIEW_TOOL_NAMES = ["preview_start", "preview_stop"] as const;
export type PreviewToolName = (typeof PREVIEW_TOOL_NAMES)[number];

export const PREVIEW_TOOLS: ChatTool[] = [
	{
		type: "function",
		function: {
			name: "preview_start",
			description:
				"Give the user a private link that opens the web project running in this coding session (a dev server or static server on a port) in their own browser or phone. Checks the port is reachable and returns the link to send to the user; it expires after about 1 hour and works while the session is running. USE after you start a web server (vite, next, http.server, serve...) and the user wants to see the result; send the link instead of screenshots and never show localhost, 127.0.0.1 or container addresses. The server must listen on 0.0.0.0 (not only 127.0.0.1). Do NOT use for sites already on the internet, for the VM browser, or to publish a site for other people.",
			parameters: {
				type: "object",
				properties: {
					port: { type: "number", description: `Port the server listens on (${PREVIEW_MIN_PORT}-${PREVIEW_MAX_PORT}; not 3090, 3128 or 3129)` },
					path: { type: "string", description: "Page to open first, starting with / (default /)" },
					base_configured: { type: "boolean", description: "Basic mode only: true when you started the server with its base path set to the prefix this tool returned (e.g. vite --base). Default false." },
				},
				required: ["port"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "preview_stop",
			description: "Close the private preview link of this coding session right away (the server keeps running). USE when the user says they are done looking, or before sharing the project another way. Do NOT use just because the 1 hour limit passed: it expires by itself.",
			parameters: { type: "object", properties: {} },
		},
	},
];

/**
 * Onde moram o domínio das prévias e a origem do Atlas (variáveis do worker/api); `null` = prévia desligada.
 * `baseDomain: null` = modo básico (sem domínio: prévia sob o caminho do Atlas, em origem opaca). Mesma regra da API (`loadPreviewConfig`).
 */
export type PreviewLinkConfig = { baseDomain: string | null; atlasUrl: string };

export function previewLinkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewLinkConfig | null {
	const atlasUrl = env.ATLAS_URL?.trim().replace(/\/+$/, "");
	if (!atlasUrl) return null;
	const baseDomain = normalizePreviewBaseDomain(env.ATLAS_PREVIEW_BASE_DOMAIN);
	// Domínio inválido ou no mesmo site do Atlas: a API cai no modo básico; a tool segue a mesma regra.
	if (!baseDomain || (env.ATLAS_PREVIEW_ALLOW_SAME_SITE !== "1" && previewBaseDomainConflict(baseDomain, atlasUrl))) return { baseDomain: null, atlasUrl };
	return { baseDomain, atlasUrl };
}

/** Link que o usuário abre: passa pelo login do Atlas e só depois vai ao domínio separado. */
export function previewOpenUrl(config: PreviewLinkConfig, sessionId: string): string {
	return `${config.atlasUrl}/v1/previews/${encodeURIComponent(sessionId)}/open`;
}

export function parsePreviewStartArgs(args: Record<string, unknown>): { port: number; path: string } {
	const port = typeof args.port === "string" && /^\d+$/.test(args.port.trim()) ? Number(args.port) : args.port;
	if (!isPreviewPort(port)) {
		throw new Error(`port must be an integer from ${PREVIEW_MIN_PORT} to ${PREVIEW_MAX_PORT}, not a reserved port (3090, 3128, 3129). Use the port your dev server prints (vite 5173, next 3000, http.server 8000...).`);
	}
	const path = normalizePreviewPath(args.path);
	if (!path) throw new Error("path must be a relative path starting with / (no // and no control characters), at most 200 characters.");
	return { port, path };
}

/** Script que roda DENTRO do container: a porta responde em 127.0.0.1? (distingue "não sobe" de "só no loopback"). */
export function loopbackProbeScript(port: number): string {
	return `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo LOOPBACK_UP || echo LOOPBACK_DOWN`;
}

export function tcpReachable(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

export type PreviewContext = {
	link: PreviewLinkConfig | null;
	/** Só no modo de rede compartilhada o container é alcançável em outras portas além da de controle. */
	connectMode: "network" | "published";
	sessionId: string;
	endpoint: DevEndpoint;
	client: Pick<DevClient, "execStart" | "execPoll">;
	/** Injetáveis em teste. */
	reachable?: (host: string, port: number) => Promise<boolean>;
	now?: () => number;
	save: (preview: DevSessionPreview | null) => Promise<void>;
};

/** Dicas só do modo básico: o projeto roda sob um prefixo, em sandbox, sem cookies/storage nem HMR. Em inglês, para o modelo. */
function basicModeNotes(prefix: string): string[] {
	return [
		`Mode: basic. The page is served under the path prefix ${prefix} in a sandbox (no cookies, localStorage or sessionStorage, no WebSocket/HMR: after edits ask the user to reload the page).`,
		`Relative asset URLs (./style.css, assets/app.js) work with any server, so plain static sites need nothing. Absolute asset URLs (/assets/app.js, Vite/CRA/Next dev servers) only work if the server's base path is ${prefix}: vite \`--base ${prefix}\`, CRA \`PUBLIC_URL=${prefix}\` (or "homepage"). If you restarted the server with that base, call preview_start again with base_configured:true. Redirects are rewritten into the prefix automatically.`,
		"If the project needs cookies, login, localStorage or live reload to work, say in plain words that the full preview needs a separate domain and offer: tell me to \"set up the full preview\". Do not mention modes, sandboxes or prefixes otherwise.",
	];
}

const NOT_CONFIGURED =
	"Live preview is not available on this server. Tell the user in plain words that the live link is not available here, and offer screenshots of the project instead.";

function serverHint(port: number): string {
	return `Restart the server bound to 0.0.0.0: vite \`--host 0.0.0.0\`, next \`-H 0.0.0.0\`, python \`-m http.server ${port} --bind 0.0.0.0\`, serve \`-l tcp://0.0.0.0:${port}\`, or HOST=0.0.0.0 for other tools. Run it with background:true, wait for it to be ready, then call preview_start again.`;
}

export async function startPreview(ctx: PreviewContext, args: Record<string, unknown>): Promise<string> {
	if (!ctx.link || ctx.connectMode !== "network") throw new Error(NOT_CONFIGURED);
	const { port, path } = parsePreviewStartArgs(args);
	const basic = !ctx.link.baseDomain;
	const basePrefixed = basic && args.base_configured === true;
	const now = ctx.now ?? Date.now;
	const host = new URL(ctx.endpoint.baseUrl).hostname;
	const reachable = ctx.reachable ?? tcpReachable;
	if (!(await reachable(host, port))) {
		let loopbackUp = false;
		try {
			const job = await ctx.client.execStart({ cmd: loopbackProbeScript(port), timeoutMs: 10_000 });
			const snap = await ctx.client.execPoll(job.id, { waitMs: 5_000 });
			loopbackUp = snap.stdout.includes("LOOPBACK_UP");
		} catch {
			// Sem diagnóstico fino: cai na mensagem genérica abaixo.
		}
		throw new Error(
			loopbackUp
				? `Port ${port} answers only on 127.0.0.1 inside the session, so the user cannot reach it. ${serverHint(port)}`
				: `Nothing is listening on port ${port}. Start the web server first (background:true), wait until it prints it is ready, then call preview_start again. ${serverHint(port)}`,
		);
	}
	const startedAt = now();
	await ctx.save({ port, path, startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + PREVIEW_TTL_MS).toISOString(), ...(basePrefixed ? { basePrefixed: true } : {}) });
	return [
		`Preview ready: ${previewOpenUrl(ctx.link, ctx.sessionId)}`,
		`Send this exact link to the user: it opens the project (port ${port}, ${path}) in their own browser or phone, only for them while logged in, for about 1 hour while the session runs.`,
		"Reply in the user's language with a short line and the link. Do not mention ports, localhost or container addresses. Do not send screenshots unless the user asks.",
		basic
			? "Edits you make show after the user reloads the page. Call preview_start again if you restart the server on another port or change its base path."
			: "Edits you make keep showing in the same link (dev servers reload on their own). Call preview_start again if you restart the server on another port.",
		...(basic ? basicModeNotes(previewBasicPrefix(ctx.sessionId)) : ["Mode: full."]),
	].join("\n");
}

export async function stopPreview(ctx: Pick<PreviewContext, "save">, hadPreview: boolean): Promise<string> {
	await ctx.save(null);
	return hadPreview ? "Preview closed: the link no longer opens. The server in the session keeps running." : "There was no active preview. Nothing to close.";
}
