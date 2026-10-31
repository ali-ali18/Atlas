import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createBrowserSession } from "./browser-session.mjs";
import { attachTabNotice, createTabScope, parseTabHeader, parseTabsRequest, runTabsAction } from "./browser-tabs.mjs";
import { createBrowserActions } from "./browser-actions.mjs";
import { collectPageText, normalizeText, paginateText } from "./text-page.mjs";
import { settleAfterAction } from "./stability.mjs";
import { compactPlaywrightError } from "./target.mjs";
import { typeWithStrategy } from "./typing.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createPageReader } from "./reader.mjs";
import { parseScreenshotOptions, scrotPlan } from "./screenshot-options.mjs";
import { withMarks } from "./marks.mjs";
import { countUserProcesses, countViewerClients, createActivityTracker } from "./activity.mjs";

const PORT = Number.parseInt(process.env.SANDBOX_CONTROL_PORT ?? "3080", 10);
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
	return execFileAsync(command, args, {
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

// --- Screenshot do desktop inteiro (root window) ---
async function captureScreen(options = { jpeg: false }) {
	const base = join(
		tmpdir(),
		`atlas-screen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const plan = scrotPlan(base, options);
	await execFileAsync("scrot", plan.args, { timeout: 20_000 });
	try {
		return await readFile(plan.read);
	} finally {
		await Promise.all(plan.cleanup.map((f) => unlink(f).catch(() => undefined)));
	}
}

async function screenGeometry() {
	const { stdout } = await run("xdotool", ["getdisplaygeometry"]);
	const [width, height] = stdout.trim().split(/\s+/).map(Number);
	return { width: width || 0, height: height || 0 };
}

// --- Controle de mouse/teclado em nível de desktop (X11 via xdotool) ---
async function clickAt(x, y) {
	await run("xdotool", [
		"mousemove",
		"--sync",
		String(Math.round(x)),
		String(Math.round(y)),
		"click",
		"1",
	]);
}

async function xdotoolType(text) {
	await run("xdotool", [
		"type",
		"--clearmodifiers",
		"--delay",
		"15",
		"--",
		text,
	]);
}

// xclip guarda a seleção em background depois de ler o stdin; stdio ignorado
// evita esperar o pipe que o processo filho herdou.
function setClipboard(text) {
	return new Promise((resolve, reject) => {
		const child = spawn("xclip", ["-selection", "clipboard", "-in"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`xclip falhou (código ${code})`)),
		);
		child.stdin.end(text);
	});
}

async function typeText(text) {
	return typeWithStrategy(text, {
		typeDirect: xdotoolType,
		setClipboard,
		pressKey,
	});
}

async function pressKey(combo) {
	await run("xdotool", ["key", "--clearmodifiers", combo]);
}

async function scrollBy(deltaX, deltaY) {
	const vertical = Math.round(deltaY / 100);
	if (vertical !== 0) {
		await run("xdotool", [
			"click",
			"--repeat",
			String(Math.min(50, Math.abs(vertical))),
			vertical > 0 ? "5" : "4",
		]);
	}
	const horizontal = Math.round(deltaX / 100);
	if (horizontal !== 0) {
		await run("xdotool", [
			"click",
			"--repeat",
			String(Math.min(50, Math.abs(horizontal))),
			horizontal > 0 ? "7" : "6",
		]);
	}
}

// --- Browser (Playwright/CDP) para navegação confiável ---
const browserSession = createBrowserSession({ chromium, cdpUrl: CDP_URL });
const { restart } = browserSession;
// V8: cabeçalho x-atlas-tab leva a requisição para a aba do subagente.
const tabScope = createTabScope(browserSession);
const { getPage, peekPage } = tabScope;

// --- Ferramentas de browser via Playwright/CDP (DOM, não pixel) ---
const actions = createBrowserActions({ getPage, restart, browserAlive: () => browserSession.isConnected() });
const { withPageRetry, browserClick, browserType, navigate } = actions;
const refActions = createRefActions({
	withPageRetry,
	clickElement: actions.clickElement,
});
const { browserSnapshot, browserAct, browserWait, observeAction } = refActions;
actions.setObserver(observeAction);
const { readPage, findText } = createPageReader({
	withPageRetry,
	registry: refActions.registry,
	collect: refActions.collect,
	locateRef: refActions.locateRef,
	observeAction,
	clickElement: actions.clickElement,
});

async function browserText({ offset, limit, mode } = {}) {
	return withPageRetry(async (p) => {
		const viewport = mode === "viewport";
		const collected = await p.evaluate(collectPageText, viewport ? "viewport" : "page");
		const page = paginateText(normalizeText(collected.text), { offset, limit });
		return {
			url: p.url(),
			title: await p.title(),
			mode: viewport ? "viewport" : "page",
			...page,
			scrollY: collected.scrollY,
			scrollHeight: collected.scrollHeight,
			viewportHeight: collected.viewportHeight,
		};
	});
}

// Posição de scroll da página (o scroll em si é do desktop/xdotool). Falha
// silenciosa: pode não haver página web (app de desktop).
async function scrollPosition() {
	const p = peekPage();
	if (!p) return {};
	try {
		return await p.evaluate(() => {
			const el = document.scrollingElement || document.documentElement;
			return {
				scrollY: Math.round(el.scrollTop),
				scrollHeight: Math.round(el.scrollHeight),
				viewportHeight: Math.round(window.innerHeight),
			};
		});
	} catch {
		return {};
	}
}

// Ações de desktop (xdotool) também mexem na página: espera estabilizar se
// houver página web ativa. Nunca sobe o Chrome só para observar.
async function desktopEffect(urlBefore) {
	const p = peekPage();
	if (!p) return {};
	return settleAfterAction(p, { urlBefore });
}

async function browserLinks() {
	return withPageRetry(async (p) => {
		const links = await p.evaluate(() =>
			Array.from(document.querySelectorAll("a"))
				.slice(0, 60)
				.map((a) => ({
					text: (a.textContent ?? "").trim().slice(0, 80),
					href: a.href,
				}))
				.filter((link) => link.href),
		);
		return { url: p.url(), links };
	});
}

// Atividade da VM (nao conta /health nem /idle): o guarda de memoria da API so para VMs realmente ociosas.
// Em uso = chamada em andamento, viewer noVNC conectado (pessoa digitando senha/2FA) ou processo do shell do agente.
const SHELL_USER = "atlas";
let shellUid = null;
function shellProcesses() {
	if (shellUid === null) {
		try {
			shellUid = Number.parseInt(execFileSync("id", ["-u", SHELL_USER], { encoding: "utf8" }).trim(), 10);
		} catch {
			shellUid = -1;
		}
	}
	return shellUid >= 0 ? countUserProcesses(shellUid) : 0;
}
const activity = createActivityTracker({ viewers: countViewerClients, shellProcesses });

const handleRequest = async (req, res) => {
	if (req.url === "/health" || req.url === "/idle") return handleControlRequest(req, res);
	const token = activity.begin();
	attachTabNotice(browserSession, req, res);
	// Cliente que desconecta com o handler preso também encerra a chamada (end é idempotente por token).
	res.once("close", () => activity.end(token));
	try {
		await handleControlRequest(req, res);
	} finally {
		activity.end(token);
	}
};

const handleControlRequest = async (req, res) => {
	try {
		if (req.method === "GET" && req.url === "/idle") {
			sendJson(res, 200, activity.snapshot());
			return;
		}

		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
			return;
		}

		if (req.method === "GET" && req.url === "/screen") {
			sendJson(res, 200, await screenGeometry());
			return;
		}

		if (
			req.method === "GET" &&
			(req.url === "/screenshot" || req.url?.startsWith("/screenshot?"))
		) {
			const options = parseScreenshotOptions(req.url);
			let buffer;
			let marks = 0;
			if (options.marks) {
				// Sem página aberta (app desktop) não há refs: captura sem marcas.
				const result = await withMarks(
					{
						withPageRetry,
						ensureRefs: () => browserSnapshot({ area: "viewport", limit: 80 }),
					},
					() => captureScreen(options),
				).catch(() => null);
				buffer = result?.buffer ?? (await captureScreen(options));
				marks = result?.marks ?? 0;
			} else {
				buffer = await captureScreen(options);
			}
			res.writeHead(200, {
				"Content-Type": options.jpeg ? "image/jpeg" : "image/png",
				"Cache-Control": "no-store",
				"X-Atlas-Marks": String(marks),
			});
			res.end(buffer);
			return;
		}

		if (req.method === "POST" && req.url === "/navigate") {
			const body = await readJsonBody(req);
			const url = body?.url;
			if (typeof url !== "string" || url.length === 0) {
				sendJson(res, 400, { error: "url required" });
				return;
			}
			// Espera o DOM acalmar (SPA): devolve url/título finais + settled.
			sendJson(res, 200, await navigate(url));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/tab/open") {
			const body = await readJsonBody(req);
			const url = typeof body?.url === "string" && body.url ? body.url : undefined;
			sendJson(res, 200, await tabScope.openTab(url));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/tab/close") {
			const body = await readJsonBody(req);
			const tabId = parseTabHeader(body?.tabId);
			if (!tabId) {
				sendJson(res, 400, { error: "tabId required" });
				return;
			}
			sendJson(res, 200, await tabScope.closeTab(tabId));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/tabs") {
			// Abas do pai: o subagente tem a própria aba isolada e não troca de aba.
			if (tabScope.currentTabId()) {
				sendJson(res, 400, { error: "browser_tabs is not available inside a subagent tab" });
				return;
			}
			let request;
			try {
				request = parseTabsRequest(await readJsonBody(req));
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
				return;
			}
			sendJson(res, 200, await runTabsAction(browserSession, request));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/click") {
			const body = await readJsonBody(req);
			sendJson(res, 200, await browserClick(body ?? {}));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/type") {
			const body = await readJsonBody(req);
			const text = body?.text;
			if (typeof text !== "string") {
				sendJson(res, 400, { error: "text required" });
				return;
			}
			sendJson(
				res,
				200,
				await browserType({
					selector: body?.selector,
					text,
					submit: Boolean(body?.submit),
					...(body?.guard && typeof body.guard === "object" ? { guard: body.guard } : {}),
				}),
			);
			return;
		}

		if (req.method === "GET" && req.url?.startsWith("/browser/text")) {
			const query = new URL(req.url, "http://localhost").searchParams;
			sendJson(
				res,
				200,
				await browserText({
					offset: query.get("offset"),
					limit: query.get("limit"),
					mode: query.get("mode"),
				}),
			);
			return;
		}

		if (req.method === "POST" && req.url === "/browser/read") {
			sendJson(res, 200, await readPage((await readJsonBody(req)) ?? {}));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/find") {
			sendJson(res, 200, await findText((await readJsonBody(req)) ?? {}));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/snapshot") {
			sendJson(res, 200, await browserSnapshot((await readJsonBody(req)) ?? {}));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/act") {
			sendJson(res, 200, await browserAct((await readJsonBody(req)) ?? {}));
			return;
		}

		if (req.method === "POST" && req.url === "/browser/wait") {
			sendJson(res, 200, await browserWait((await readJsonBody(req)) ?? {}));
			return;
		}

		if (req.method === "GET" && req.url === "/browser/links") {
			sendJson(res, 200, await browserLinks());
			return;
		}

		if (req.method === "POST" && req.url === "/click") {
			const body = await readJsonBody(req);
			const x = Number(body?.x);
			const y = Number(body?.y);
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				sendJson(res, 400, { error: "x and y required" });
				return;
			}
			const before = peekPage()?.url();
			await clickAt(x, y);
			sendJson(res, 200, { ok: true, ...(await desktopEffect(before)) });
			return;
		}

		if (req.method === "POST" && req.url === "/type") {
			const body = await readJsonBody(req);
			const text = body?.text;
			if (typeof text !== "string") {
				sendJson(res, 400, { error: "text required" });
				return;
			}
			const before = peekPage()?.url();
			await typeText(text);
			sendJson(res, 200, { ok: true, ...(await desktopEffect(before)) });
			return;
		}

		if (req.method === "POST" && req.url === "/key") {
			const body = await readJsonBody(req);
			const combo = body?.combo;
			if (typeof combo !== "string" || combo.trim().length === 0) {
				sendJson(res, 400, { error: "combo required" });
				return;
			}
			const before = peekPage()?.url();
			await pressKey(combo.trim());
			sendJson(res, 200, { ok: true, ...(await desktopEffect(before)) });
			return;
		}

		if (req.method === "POST" && req.url === "/scroll") {
			const body = await readJsonBody(req);
			const deltaX = Number(body?.deltaX ?? 0);
			const deltaY = Number(body?.deltaY ?? 0);
			if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
				sendJson(res, 400, { error: "deltaX/deltaY must be numbers" });
				return;
			}
			await scrollBy(deltaX, deltaY);
			// A roda do mouse é assíncrona na página: dá um respiro antes de ler.
			await new Promise((resolve) => setTimeout(resolve, 150));
			sendJson(res, 200, { ok: true, ...(await scrollPosition()) });
			return;
		}

		sendJson(res, 404, { error: "not found" });
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		console.error("[sandbox-control]", compactPlaywrightError(message, 500));
		// O call log do Playwright (2 a 4 KB) não vai ao modelo.
		sendJson(res, 500, { error: compactPlaywrightError(message) });
	}
};

const server = http.createServer((req, res) => {
	let tabId;
	try {
		tabId = parseTabHeader(req.headers["x-atlas-tab"]);
	} catch {
		sendJson(res, 400, { error: "invalid tab id" });
		return;
	}
	tabScope.run(tabId, () => handleRequest(req, res));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`[sandbox-control] listening on ${PORT}, CDP ${CDP_URL}`);
});
