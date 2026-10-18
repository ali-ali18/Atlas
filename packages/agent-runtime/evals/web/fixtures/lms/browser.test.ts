import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./server.mjs";

// L1 do PLANO-VM: o fixture reproduz as armadilhas de verdade num Chrome. Sem Chrome local
// (CI sem navegador) a suíte inteira é omitida; `ATLAS_EVAL_CHROME` aponta para o executável.
const CHROME_CANDIDATES = [
	process.env.ATLAS_EVAL_CHROME,
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chromePath = CHROME_CANDIDATES.find((path) => path && existsSync(path));

describe.skipIf(!chromePath)("fixture LMS no Chrome - armadilhas reproduzidas", () => {
	let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
	let browser: Browser;
	let page: Page;

	beforeAll(async () => {
		fixture = await startFixtureServer({ host: "127.0.0.1" });
		browser = await chromium.launch({ executablePath: chromePath, headless: true });
	}, 60_000);
	afterAll(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const open = async (path: string) => {
		const context = await browser.newContext();
		page = await context.newPage();
		await page.goto(`${fixture.url}${path}`, { waitUntil: "domcontentloaded" });
	};

	it("o banner de consentimento e o link-overlay interceptam o clique no título", async () => {
		await open("/courses");
		await expect(page.getByText("Software Design", { exact: true }).click({ timeout: 1500 })).rejects.toThrow(/intercepts pointer events/);
		await page.click("#consent-reject");
		// Sem o banner, o <a> esticado ainda cobre o <span> do título.
		await expect(page.getByText("Software Design", { exact: true }).click({ timeout: 1500 })).rejects.toThrow(/intercepts pointer events/);
		// O <a> esticado não tem caixa própria: só um clique de coordenada (o que o overlay cobre) o aciona.
		const box = await page.locator('[data-course="c103"]').boundingBox();
		await page.mouse.click(box!.x + 8, box!.y + 8);
		await page.waitForURL(/\/course\/c103$/);
	}, 30_000);

	it("a SPA começa vazia e hidrata depois; acordeão é exclusivo e carrega ao expandir", async () => {
		await open("/course/c103");
		expect(await page.locator("#app").innerText()).toBe("");
		await page.locator("h1").waitFor();
		await page.click("#consent-reject");
		await page.click('button[data-week="1"]');
		expect(await page.locator(".panel:not([hidden])").innerText()).toBe("Loading...");
		await page.getByText("Modular thinking - lecture notes").waitFor();
		await page.click('button[data-week="2"]');
		expect(await page.getAttribute('button[data-week="1"]', "aria-expanded")).toBe("false");
		expect(await page.locator(".panel:not([hidden])").count()).toBe(1);
	}, 30_000);

	it("semana 2 abre modal, semana 4 usa iframe e semana 7 usa shadow DOM", async () => {
		await open("/course/c103");
		await page.locator("h1").waitFor();
		await page.click("#consent-reject");
		await page.click('button[data-week="2"]');
		await page.click(".activity-card");
		const dialog = page.getByRole("dialog", { name: "Workshop brief: Coupling and cohesion" });
		expect(await dialog.innerText()).toContain("Due date: 2026-11-03");
		await page.click("#modal-close");
		await page.click('button[data-week="4"]');
		await page.locator("iframe").waitFor();
		const frameText = await page.frameLocator("iframe").locator("body").innerText();
		expect(frameText).toContain("Checkpoint code IF-4403");
		expect(await page.locator("body").innerText()).not.toContain("IF-4403");
		await page.click('button[data-week="7"]');
		await page.locator(".shadow-host").waitFor();
		expect(await page.locator("body").innerText()).not.toContain("SH-7703");
		expect(await page.evaluate(() => document.querySelector(".shadow-host")?.shadowRoot?.textContent)).toBe("Checkpoint code SH-7703");
	}, 30_000);

	it("a rota 'about' troca de página sem recarregar (pushState)", async () => {
		await open("/course/c103");
		await page.locator("h1").waitFor();
		await page.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
		await page.click("#consent-reject");
		await page.click('a[href="/course/c103/about"]');
		await page.getByText("Instructor: Prof. Helena Duarte").waitFor();
		expect(page.url()).toBe(`${fixture.url}/course/c103/about`);
		expect(await page.title()).toBe("About - Software Design");
		expect(await page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(1);
	}, 30_000);

	it("o valor do gráfico só existe no canvas", async () => {
		await open("/stats");
		expect(await page.locator("body").innerText()).not.toContain("73");
		expect(await page.locator("canvas").count()).toBe(1);
	}, 30_000);
});
