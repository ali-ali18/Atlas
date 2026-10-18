// Helper dos testes com Chromium real (não é um teste): sobe um servidor HTTP
// local com fixtures e abre uma página do Playwright. Se o Chromium ou o
// playwright-core não existirem na máquina, `launchFixtureBrowser` devolve
// null e os testes se pulam (a CI da imagem não roda estes).
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function loadChromium() {
	try {
		return (await import("playwright-core")).chromium;
	} catch {
		// Workspace pnpm: o pacote mora em .pnpm na raiz do repositório.
	}
	let dir = here;
	for (let i = 0; i < 6; i += 1) {
		const store = join(dir, "node_modules", ".pnpm");
		if (existsSync(store)) {
			const found = readdirSync(store).find((name) => name.startsWith("playwright-core@"));
			if (found) {
				const entry = join(store, found, "node_modules", "playwright-core", "index.mjs");
				if (existsSync(entry)) return (await import(pathToFileURL(entry).href)).chromium;
			}
		}
		dir = dirname(dir);
	}
	return null;
}

/** Chromium da versão do playwright, ou qualquer chromium-* baixado antes, ou ATLAS_TEST_CHROMIUM. */
function findChromium(chromium) {
	const candidates = [process.env.ATLAS_TEST_CHROMIUM, chromium.executablePath()];
	const cache = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright");
	if (existsSync(cache)) {
		for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
			candidates.push(join(cache, dir, "chrome-win64", "chrome.exe"), join(cache, dir, "chrome-linux", "chrome"));
		}
	}
	return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** `pages`: { "/caminho": "<html>" }. Qualquer outro caminho vira uma página-destino. */
export async function launchFixtureBrowser(pages) {
	const chromium = await loadChromium();
	if (!chromium) return null;
	const executablePath = findChromium(chromium);
	if (!executablePath) return null;
	const server = http.createServer((req, res) => {
		const path = String(req.url).split("?")[0];
		const html = pages[path] ?? `<html><title>dest ${path}</title><body><h1>destination ${path}</h1></body></html>`;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch({ headless: true, executablePath });
	const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
	return {
		base,
		newPage: () => context.newPage(),
		close: async () => {
			await browser.close();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
