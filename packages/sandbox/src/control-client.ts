import {
	runSandboxOperation,
	type SandboxExecutionContext,
} from "./execution-context.js";
import type {
	ControlActParams,
	ControlActResult,
	ControlReadOptions,
	ControlReadResult,
	ControlFindOptions,
	ControlFindResult,
	ControlSnapshotOptions,
	ControlSnapshotResult,
	ControlWaitParams,
	ControlWaitResult,
	ControlActionResult,
	ControlBrowserClickResult,
	ControlBrowserLinksResult,
	ControlBrowserTextOptions,
	ControlBrowserTextResult,
	ControlNavigateResult,
	ControlScreenResult,
	ControlScrollResult,
	ControlTabsParams,
	ControlTabsResult,
} from "./types.js";

export class SandboxControlError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "SandboxControlError";
	}
}

/** O control server responde erros como {"error": "..."}: entrega só a mensagem. */
function unwrapControlError(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		return typeof parsed.error === "string" ? parsed.error : text;
	} catch {
		return text;
	}
}

/** Cabeçalhos das chamadas de browser: a aba do subagente (se houver) vai em `x-atlas-tab`. */
function controlHeaders(
	context: SandboxExecutionContext,
	base: Record<string, string> = {},
): Record<string, string> {
	return context.tabId ? { ...base, "x-atlas-tab": context.tabId } : base;
}

function controlBaseUrl(host: string, port: number): string {
	return `http://${host}:${port}`;
}

// O control server avisa (cabeçalho) quando uma aba nova abriu ou a ativa fechou. O aviso
// espera aqui até o runtime anexá-lo ao resultado da ferramenta; só a aba do pai o consome.
const TAB_NOTICE_HEADER = "x-atlas-tab-notice";
const tabNotices = new Map<string, { text: string; at: number }>();
/** Aviso que ninguém leu em 5 min é de outra época: descarta. */
const TAB_NOTICE_TTL_MS = 5 * 60_000;
const TAB_NOTICE_MAX_CHARS = 1200;

function captureTabNotice(host: string, port: number, context: SandboxExecutionContext, response: Response): void {
	const raw = response.headers?.get(TAB_NOTICE_HEADER);
	if (!raw || context.tabId) return;
	let text: string;
	try {
		text = decodeURIComponent(raw);
	} catch {
		return;
	}
	const key = `${host}:${port}`;
	const previous = tabNotices.get(key);
	const fresh = previous && Date.now() - previous.at < TAB_NOTICE_TTL_MS ? previous.text : "";
	// Fica o fim (o mais novo) quando ninguém leu por muitas chamadas.
	tabNotices.set(key, { text: (fresh ? `${fresh} ${text}` : text).slice(-TAB_NOTICE_MAX_CHARS), at: Date.now() });
}

/** Lê e limpa o aviso de aba pendente da VM (undefined se não há). */
export function takeTabNotice(host: string, port: number): string | undefined {
	const key = `${host}:${port}`;
	const entry = tabNotices.get(key);
	tabNotices.delete(key);
	return entry && Date.now() - entry.at < TAB_NOTICE_TTL_MS ? entry.text : undefined;
}

/** A VM que usava essa porta acabou ou outra nasceu nela: o aviso pendente não é desta VM. */
export function clearTabNoticesForPort(port: number): void {
	for (const key of tabNotices.keys()) if (key.endsWith(`:${port}`)) tabNotices.delete(key);
}

async function controlPost(
	host: string,
	port: number,
	path: string,
	body: unknown,
	timeoutMs: number,
	context: SandboxExecutionContext = {},
): Promise<void> {
	return runSandboxOperation(context, timeoutMs, async (signal) => {
		const response = await fetch(`${controlBaseUrl(host, port)}${path}`, {
			method: "POST",
			headers: controlHeaders(context, { "Content-Type": "application/json" }),
			body: JSON.stringify(body),
			signal: signal,
		});
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				unwrapControlError(text) || `${path} failed (${response.status})`,
				response.status,
			);
		}
	});
}

async function controlPostJson<T>(
	host: string,
	port: number,
	path: string,
	body: unknown,
	timeoutMs: number,
	context: SandboxExecutionContext = {},
): Promise<T> {
	return runSandboxOperation(context, timeoutMs, async (signal) => {
		const response = await fetch(`${controlBaseUrl(host, port)}${path}`, {
			method: "POST",
			headers: controlHeaders(context, { "Content-Type": "application/json" }),
			body: JSON.stringify(body),
			signal: signal,
		});
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				unwrapControlError(text) || `${path} failed (${response.status})`,
				response.status,
			);
		}
		return (await response.json()) as T;
	});
}

async function controlGetJson<T>(
	host: string,
	port: number,
	path: string,
	timeoutMs: number,
	context: SandboxExecutionContext = {},
): Promise<T> {
	return runSandboxOperation(context, timeoutMs, async (signal) => {
		const response = await fetch(`${controlBaseUrl(host, port)}${path}`, {
			method: "GET",
			headers: controlHeaders(context),
			signal: signal,
		});
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				unwrapControlError(text) || `${path} failed (${response.status})`,
				response.status,
			);
		}
		return (await response.json()) as T;
	});
}

export async function controlNavigate(
	host: string,
	port: number,
	url: string,
	context: SandboxExecutionContext = {},
): Promise<ControlNavigateResult> {
	return runSandboxOperation(context, 120_000, async (signal) => {
		const response = await fetch(`${controlBaseUrl(host, port)}/navigate`, {
			method: "POST",
			headers: controlHeaders(context, { "Content-Type": "application/json" }),
			body: JSON.stringify({ url }),
			signal: signal,
		});
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				text || `Navigate failed (${response.status})`,
				response.status,
			);
		}
		return (await response.json()) as ControlNavigateResult;
	});
}

/** Sem opções: PNG integral. Com `scalePercent`/`jpegQuality`: JPEG reduzido p/ o modelo. */
export type ControlScreenshotOptions = {
	scalePercent?: number;
	jpegQuality?: number;
	/** Recorte (zoom) em pixels da TELA real. */
	region?: { x: number; y: number; width: number; height: number };
	/** Set-of-Mark: numera na imagem os refs do snapshot. */
	marks?: boolean;
};

export async function controlScreenshot(
	host: string,
	port: number,
	options: ControlScreenshotOptions = {},
	context: SandboxExecutionContext = {},
): Promise<Buffer> {
	return runSandboxOperation(context, 60_000, async (signal) => {
		const query = new URLSearchParams();
		if (options.scalePercent !== undefined) {
			query.set("scalePct", String(Math.round(options.scalePercent)));
		}
		if (options.jpegQuality !== undefined) {
			query.set("quality", String(Math.round(options.jpegQuality)));
		}
		if (options.region) {
			const { x, y, width, height } = options.region;
			query.set(
				"region",
				[x, y, width, height].map((n) => Math.round(n)).join(","),
			);
		}
		if (options.marks) query.set("marks", "1");
		const suffix = query.size > 0 ? `?${query}` : "";
		const response = await fetch(
			`${controlBaseUrl(host, port)}/screenshot${suffix}`,
			{
				method: "GET",
				signal: signal,
			},
		);
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				text || `Screenshot failed (${response.status})`,
				response.status,
			);
		}
		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	});
}

export async function controlScreen(
	host: string,
	port: number,
	context: SandboxExecutionContext = {},
): Promise<ControlScreenResult> {
	return runSandboxOperation(context, 15_000, async (signal) => {
		const response = await fetch(`${controlBaseUrl(host, port)}/screen`, {
			method: "GET",
			signal: signal,
		});
		captureTabNotice(host, port, context, response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SandboxControlError(
				text || `Screen geometry failed (${response.status})`,
				response.status,
			);
		}
		return (await response.json()) as ControlScreenResult;
	});
}

/** Clique no desktop (coordenadas da tela) via xdotool. */
export async function controlClick(
	host: string,
	port: number,
	x: number,
	y: number,
	context: SandboxExecutionContext = {},
): Promise<ControlActionResult> {
	return controlPostJson<ControlActionResult>(
		host,
		port,
		"/click",
		{ x, y },
		30_000,
		context,
	);
}

/** Digita texto no elemento focado. */
export async function controlType(
	host: string,
	port: number,
	text: string,
	context: SandboxExecutionContext = {},
): Promise<ControlActionResult> {
	return controlPostJson<ControlActionResult>(
		host,
		port,
		"/type",
		{ text },
		60_000,
		context,
	);
}

/** Atalho de teclado (formato xdotool, ex.: "ctrl+l", "Return"). */
export async function controlKey(
	host: string,
	port: number,
	combo: string,
	context: SandboxExecutionContext = {},
): Promise<ControlActionResult> {
	return controlPostJson<ControlActionResult>(
		host,
		port,
		"/key",
		{ combo },
		30_000,
		context,
	);
}

/** Scroll no desktop (delta em pixels; convertido em passos de roda). */
export async function controlScroll(
	host: string,
	port: number,
	deltaX: number,
	deltaY: number,
	context: SandboxExecutionContext = {},
): Promise<ControlScrollResult> {
	const result = await controlPostJson<ControlScrollResult | null>(
		host,
		port,
		"/scroll",
		{ deltaX, deltaY },
		30_000,
		context,
	);
	return result ?? {};
}

/** Clica num elemento do DOM (por seletor CSS ou texto) via Playwright. */
export async function controlBrowserClick(
	host: string,
	port: number,
	params: { selector?: string; text?: string },
	context: SandboxExecutionContext = {},
): Promise<ControlBrowserClickResult> {
	return controlPostJson<ControlBrowserClickResult>(
		host,
		port,
		"/browser/click",
		params,
		30_000,
		context,
	);
}

/**
 * Login do Cofre: o control server confere o campo (senha = input[type=password] do documento principal;
 * usuário = texto/e-mail/telefone do mesmo formulário da senha) e a origem da aba antes de digitar.
 */
export type BrowserTypeGuard = { kind: "password" | "username"; origin?: string };

/** Preenche um campo do DOM (ou digita no foco) via Playwright. */
export async function controlBrowserType(
	host: string,
	port: number,
	params: { selector?: string; text: string; submit?: boolean; guard?: BrowserTypeGuard },
	context: SandboxExecutionContext = {},
): Promise<ControlActionResult> {
	return controlPostJson<ControlActionResult>(
		host,
		port,
		"/browser/type",
		params,
		30_000,
		context,
	);
}

/** Extrai o texto visível da página atual. */
export async function controlBrowserText(
	host: string,
	port: number,
	options: ControlBrowserTextOptions = {},
	context: SandboxExecutionContext = {},
): Promise<ControlBrowserTextResult> {
	const query = new URLSearchParams();
	if (options.offset !== undefined) query.set("offset", String(options.offset));
	if (options.limit !== undefined) query.set("limit", String(options.limit));
	if (options.mode) query.set("mode", options.mode);
	const suffix = query.size > 0 ? `?${query.toString()}` : "";
	return controlGetJson<ControlBrowserTextResult>(
		host,
		port,
		`/browser/text${suffix}`,
		20_000,
		context,
	);
}

export type ControlActivity = {
	/** 0 enquanto a VM está em uso. */
	idleMs: number;
	/** Chamada em andamento, viewer conectado ou comando no shell do agente. */
	busy: boolean;
};

/** Atividade da VM (GET /idle). Imagem antiga sem os campos novos devolve só `idleMs`. */
export async function controlActivity(host: string, port: number, context: SandboxExecutionContext = {}): Promise<ControlActivity> {
	const body = await controlGetJson<{ idleMs?: unknown; busy?: unknown }>(host, port, "/idle", 3_000, context);
	if (typeof body.idleMs !== "number" || !Number.isFinite(body.idleMs)) throw new Error("control /idle returned no idleMs");
	return { idleMs: body.idleMs, busy: body.busy === true };
}

/** Lista os links da página atual. */
export async function controlBrowserLinks(
	host: string,
	port: number,
	context: SandboxExecutionContext = {},
): Promise<ControlBrowserLinksResult> {
	return controlGetJson<ControlBrowserLinksResult>(
		host,
		port,
		"/browser/links",
		20_000,
		context,
	);
}

/** Snapshot dos elementos interativos da página, com refs `eN`. */
export async function controlBrowserSnapshot(
	host: string,
	port: number,
	options: ControlSnapshotOptions = {},
	context: SandboxExecutionContext = {},
): Promise<ControlSnapshotResult> {
	return controlPostJson<ControlSnapshotResult>(
		host,
		port,
		"/browser/snapshot",
		options,
		30_000,
		context,
	);
}

/** Leitura da página inteira (todos os frames e shadow DOM), com expand opcional. */
export async function controlBrowserRead(
	host: string,
	port: number,
	options: ControlReadOptions = {},
	context: SandboxExecutionContext = {},
): Promise<ControlReadResult> {
	// expand abre seção por seção (até ~45 s no servidor): teto de rede maior.
	return controlPostJson<ControlReadResult>(
		host,
		port,
		"/browser/read",
		options,
		options.expand ? 90_000 : 30_000,
		context,
	);
}

/** Procura texto/regex em todos os frames, com ref e contexto. */
export async function controlBrowserFind(
	host: string,
	port: number,
	options: ControlFindOptions,
	context: SandboxExecutionContext = {},
): Promise<ControlFindResult> {
	return controlPostJson<ControlFindResult>(host, port, "/browser/find", options, 30_000, context);
}

/** Age num elemento pelo ref do último snapshot. */
export async function controlBrowserAct(
	host: string,
	port: number,
	params: ControlActParams,
	context: SandboxExecutionContext = {},
): Promise<ControlActResult> {
	return controlPostJson<ControlActResult>(
		host,
		port,
		"/browser/act",
		params,
		45_000,
		context,
	);
}

/** Espera texto/ref/url/rede/estabilidade, com teto no servidor. */
export async function controlBrowserWait(
	host: string,
	port: number,
	params: ControlWaitParams,
	context: SandboxExecutionContext = {},
): Promise<ControlWaitResult> {
	return controlPostJson<ControlWaitResult>(
		host,
		port,
		"/browser/wait",
		params,
		45_000,
		context,
	);
}

/** Abre uma aba nova no mesmo perfil do navegador (V8). Devolve o id para `context.tabId`. */
export async function controlTabOpen(
	host: string,
	port: number,
	url: string | undefined,
	context: SandboxExecutionContext = {},
): Promise<{ tabId: string }> {
	// Sem tabId no contexto: abrir/fechar aba é sempre uma operação do pai.
	return controlPostJson<{ tabId: string }>(
		host,
		port,
		"/browser/tab/open",
		url ? { url } : {},
		60_000,
		{ ...context, tabId: undefined },
	);
}

/** Fecha uma aba aberta por `controlTabOpen`. Idempotente. */
export async function controlTabClose(
	host: string,
	port: number,
	tabId: string,
	context: SandboxExecutionContext = {},
): Promise<{ closed: boolean }> {
	return controlPostJson<{ closed: boolean }>(
		host,
		port,
		"/browser/tab/close",
		{ tabId },
		15_000,
		{ ...context, tabId: undefined },
	);
}

/** Abas do navegador do pai: lista, troca ou fecha (índice a partir de 1, o da lista). */
export async function controlBrowserTabs(
	host: string,
	port: number,
	params: ControlTabsParams,
	context: SandboxExecutionContext = {},
): Promise<ControlTabsResult> {
	return controlPostJson<ControlTabsResult>(host, port, "/browser/tabs", params, 20_000, context);
}
