import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { executeTool } from "@workspace/agent-runtime";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Computador de bancada do bench: roda o servidor de controle REAL da VM (`docker/agent-sandbox/control/server.mjs`,
 * o mesmo código da imagem) contra um Chromium local, sem Docker. O que a VM faz com X11 (rolar, teclar, tela inteira)
 * não existe fora do container; um proxy fala o MESMO contrato HTTP para essas rotas (`/scroll`, `/key`, `/click`,
 * `/type`, `/screen`, `/screenshot`) usando o Playwright, e repassa todo o resto ao servidor real. O `SandboxManager`
 * que as tools usam é um adaptador fino sobre esse contrato (o mesmo `fetch` que o `control-client` do pacote faz).
 * Ver `README.md` ("Bench do navegador") para o que é e o que não é fiel à VM.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROL_DIR = resolve(HERE, "../../../../docker/agent-sandbox/control");

export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
	const candidates: string[] = [env.ATLAS_TEST_CHROMIUM ?? ""];
	for (const base of [env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(env.HOME ?? "", ".cache", "ms-playwright")]) {
		if (!base || !existsSync(base)) continue;
		for (const dir of readdirSync(base).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) candidates.push(join(base, dir, "chrome-linux", "chrome"), join(base, dir, "chrome-win64", "chrome.exe"));
	}
	return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

const freePort = () =>
	new Promise<number>((resolvePort, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolvePort(port));
		});
	});

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await check().catch(() => false)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 150));
	}
	throw new Error(`bench: ${what} não ficou pronto em ${timeoutMs} ms`);
}

const httpOk = (url: string) => fetch(url).then((response) => response.ok);

/** O gerente da VM que as tools usam (só os `exec*` do navegador existem no bench). */
export type BenchManager = Parameters<typeof executeTool>[2]["manager"];

export type BenchVm = {
  manager: BenchManager;
  sessionId: string;
  /** Página ativa (para o bench conferir o estado final). */
  activePage: () => Promise<Page | null>;
  close: () => Promise<void>;
};

export async function startBenchVm(): Promise<BenchVm> {
	const executablePath = findChromium();
	if (!executablePath) throw new Error("bench: nenhum Chromium encontrado (defina ATLAS_TEST_CHROMIUM ou PLAYWRIGHT_BROWSERS_PATH).");
	const [cdpPort, controlPort, proxyPort] = await Promise.all([freePort(), freePort(), freePort()]);
	const workDir = await mkdtemp(join(tmpdir(), "atlas-bench-vm-"));
	const children: ChildProcess[] = [];
	const proxies: http.Server[] = [];
	let observer: Browser | undefined;

	// Cópia do servidor de controle com o playwright-core ao lado (o diretório da imagem não tem node_modules no repo).
	const controlCopy = join(workDir, "control");
	await cp(CONTROL_DIR, controlCopy, { recursive: true, filter: (source) => !/\.test\.mjs$/.test(source) && !source.includes("node_modules") });
	const playwrightRoot = dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
	await rm(join(controlCopy, "node_modules"), { recursive: true, force: true });
	await symlink(dirname(playwrightRoot), join(controlCopy, "node_modules"), "dir");

	const chrome = spawn(executablePath, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(workDir, "profile")}`, "--no-sandbox", "--disable-gpu", "--window-size=1280,800", "--no-first-run", "about:blank"], { stdio: "ignore" });
	children.push(chrome);
	await waitFor(() => httpOk(`http://127.0.0.1:${cdpPort}/json/version`), "Chromium (CDP)");

	const control = spawn(process.execPath, [join(controlCopy, "server.mjs")], { env: { ...process.env, SANDBOX_CONTROL_PORT: String(controlPort), CDP_URL: `http://127.0.0.1:${cdpPort}` }, stdio: "ignore" });
	children.push(control);
	await waitFor(() => httpOk(`http://127.0.0.1:${controlPort}/health`), "servidor de controle");

	observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
	const activePage = async (): Promise<Page | null> => {
		const pages = observer!.contexts().flatMap((context) => context.pages());
		return pages.filter((page) => page.url() !== "about:blank").at(-1) ?? pages.at(-1) ?? null;
	};

	// --- proxy: as rotas de X11 viram Playwright; o resto vai para o servidor real ---
	const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
	const readBody = (req: http.IncomingMessage) =>
		new Promise<Record<string, unknown>>((resolveBody) => {
			let raw = "";
			req.on("data", (chunk) => (raw += chunk));
			req.on("end", () => {
				try {
					resolveBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
				} catch {
					resolveBody({});
				}
			});
		});
	const proxy = http.createServer(async (req, res) => {
		const path = String(req.url).split("?")[0]!;
		const page = await activePage();
		try {
			if (req.method === "POST" && path === "/scroll" && page) {
				const body = await readBody(req);
				await page.mouse.move(640, 400);
				await page.mouse.wheel(Number(body.deltaX ?? 0), Number(body.deltaY ?? 0));
				await page.waitForTimeout(400);
				const pos = await page.evaluate(() => {
					const el = document.scrollingElement || document.documentElement;
					return { scrollY: Math.round(el.scrollTop), scrollHeight: Math.round(el.scrollHeight), viewportHeight: Math.round(window.innerHeight) };
				});
				return json(res, 200, { ok: true, ...pos });
			}
			if (req.method === "POST" && path === "/key" && page) {
				await page.keyboard.press(String((await readBody(req)).combo ?? "")).catch(() => undefined);
				return json(res, 200, { ok: true });
			}
			if (req.method === "POST" && path === "/click" && page) {
				const body = await readBody(req);
				await page.mouse.click(Number(body.x), Number(body.y));
				return json(res, 200, { ok: true });
			}
			if (req.method === "POST" && path === "/type" && page) {
				await page.keyboard.type(String((await readBody(req)).text ?? ""));
				return json(res, 200, { ok: true });
			}
			if (req.method === "GET" && path === "/screen") return json(res, 200, { width: 1280, height: 800 });
			if (req.method === "GET" && path === "/screenshot" && page) {
				const png = await page.screenshot({ type: "jpeg", quality: 60 });
				return void res.writeHead(200, { "Content-Type": "image/jpeg", "X-Atlas-Marks": "0" }).end(png);
			}
		} catch (error) {
			return json(res, 500, { error: error instanceof Error ? error.message : "erro" });
		}
		const forward = http.request({ host: "127.0.0.1", port: controlPort, path: req.url, method: req.method, headers: req.headers }, (upstream) => {
			res.writeHead(upstream.statusCode ?? 502, upstream.headers);
			upstream.pipe(res);
		});
		forward.on("error", (error) => json(res, 502, { error: error.message }));
		req.pipe(forward);
	});
	await new Promise<void>((resolveListen) => proxy.listen(proxyPort, "127.0.0.1", resolveListen));
	proxies.push(proxy);

	const base = `http://127.0.0.1:${proxyPort}`;
	const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000): Promise<T> => {
		const response = await fetch(`${base}${path}`, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let message = text;
			try {
				message = (JSON.parse(text) as { error?: string }).error ?? text;
			} catch {
				// texto puro
			}
			throw new Error(message || `${path} falhou (${response.status})`);
		}
		return (await response.json()) as T;
	};
	const bytes = async (path: string) => Buffer.from(await (await fetch(`${base}${path}`)).arrayBuffer());

	// Só o que as tools do navegador (v3 e atuais) chamam. O cast é no objeto inteiro: o resto do gerente não existe no bench.
	const shim = {
		execNavigate: (_s: string, url: string) => call("POST", "/navigate", { url }, 120_000),
		execBrowserSnapshot: (_s: string, options: unknown) => call("POST", "/browser/snapshot", options ?? {}, 30_000),
		execBrowserAct: (_s: string, params: unknown) => call("POST", "/browser/act", params, 45_000),
		execBrowserWait: (_s: string, params: unknown) => call("POST", "/browser/wait", params, 45_000),
		execBrowserRead: (_s: string, options: unknown) => call("POST", "/browser/read", options ?? {}, 30_000),
		execBrowserFind: (_s: string, options: unknown) => call("POST", "/browser/find", options, 30_000),
		execBrowserClick: (_s: string, params: unknown) => call("POST", "/browser/click", params, 45_000),
		execBrowserType: (_s: string, params: unknown) => call("POST", "/browser/type", params, 45_000),
		execBrowserText: (_s: string, options: { offset?: number; limit?: number; mode?: string } = {}) => call("GET", `/browser/text?${new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`),
		execBrowserLinks: () => call("GET", "/browser/links"),
		execBrowserTabs: (_s: string, params: unknown) => call("POST", "/browser/tabs", params),
		execScroll: (_s: string, deltaX: number, deltaY: number) => call("POST", "/scroll", { deltaX, deltaY }),
		execClick: (_s: string, x: number, y: number) => call("POST", "/click", { x, y }),
		execType: (_s: string, text: string) => call("POST", "/type", { text }),
		execKey: (_s: string, combo: string) => call("POST", "/key", { combo }),
		execScreen: () => call("GET", "/screen"),
		execScreenshot: () => bytes("/screenshot"),
		takeTabNotice: () => undefined,
	};

	return {
		manager: shim as unknown as BenchManager,
		sessionId: "bench-vm",
		activePage,
		close: async () => {
			await observer?.close().catch(() => undefined);
			for (const server of proxies) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			for (const child of children.reverse()) child.kill("SIGKILL");
			await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}
