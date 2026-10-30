/**
 * Prova no Chromium de que a prévia do modo básico roda em origem opaca e não alcança o login do Atlas.
 * Não faz parte da suíte (precisa do Playwright global e de um Chromium); rode à mão:
 *   [PW_CHROMIUM=/caminho/do/chrome] NODE_PATH=/opt/node-tools/node_modules NODE_ENV=test ATLAS_HOOK_PEPPER=x ATLAS_OWNER_EMAIL=o@t.l \
 *   BETTER_AUTH_SECRET=test-secret-test-secret-test-secret pnpm exec tsx e2e/previa-basica.playwright.ts
 * Sai com código 1 se algum item falhar. O "Atlas" aqui é um servidor mínimo com um cookie de login e `/v1/me`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PREVIEW_COOKIE, createPreviewBasicRoutes, createPreviewOpenRoutes, createPreviewService } from "../src/routes/previews.js";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const ID = "cmabc123def456ghi789jkl01";
const PREFIX = `/v1/previews/${ID}/p/`;
const seenAtlas: Array<{ path: string; cookie: string | undefined }> = [];

// Projeto "do usuário": página que inspeciona o próprio ambiente e tenta alcançar o Atlas.
const upstream = http.createServer((req, res) => {
	res.setHeader("Set-Cookie", "sid=1; Path=/");
	if (req.url?.startsWith("/app.js")) {
		res.setHeader("Content-Type", "application/javascript");
		return void res.end("document.getElementById('sub').textContent='subrecurso-ok';");
	}
	res.setHeader("Content-Type", "text/html");
	res.end(`<!doctype html><body><p id="sub">pendente</p><script src="app.js"></script><script>
// location.origin vem da URL; self.origin (origem do documento) é o que vale null no sandbox.
const r = { origin: self.origin, locationOrigin: location.origin, isolated: self.crossOriginIsolated };
try { r.cookie = 'len=' + document.cookie.length; } catch (e) { r.cookie = 'THROWS ' + e.name; }
try { localStorage.setItem('x', '1'); r.localStorage = 'ok'; } catch (e) { r.localStorage = 'THROWS ' + e.name; }
Promise.allSettled([
  fetch('/v1/me?same-host', { credentials: 'include', mode: 'no-cors' }).then(() => 'enviada'),
  fetch('/v1/me?cors', { credentials: 'include' }).then((x) => x.text()),
]).then((all) => { r.fetchNoCors = all[0].status; r.fetchCors = all[1].status === 'rejected' ? 'bloqueada pelo CORS' : 'LEU: ' + all[1].value; window.__r = r; document.title = 'pronto'; });
</script></body>`);
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as AddressInfo).port;

const atlas = new Hono();
let atlasUrl = "";
const record = { id: ID, userId: "dono", conversationId: "c", repo: null, branch: null, baseBranch: null, status: "RUNNING", tier: "small", containerId: "x", todos: [], pr: null, lastError: null, createdAt: new Date(), updatedAt: new Date(), lastActiveAt: new Date(), preview: { port: upstreamPort, path: "/", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } } as never;
const deps = {
	config: { baseDomain: null, scheme: "http" as const, atlasUrl: "", secret: "segredo-e2e", },
	getSessionById: async () => record,
	getOwnedSession: async () => record,
	resolveContainerHost: async () => "127.0.0.1",
	touch: async () => undefined,
};
const service = createPreviewService(deps);
atlas.get("/login", (c) => {
	c.header("Set-Cookie", "atlas_session=SEGREDO-DO-ATLAS; Path=/; HttpOnly; SameSite=Lax");
	return c.text("logado");
});
atlas.get("/v1/me", (c) => {
	seenAtlas.push({ path: new URL(c.req.url).pathname + new URL(c.req.url).search, cookie: c.req.header("cookie") });
	return c.json({ user: "dono", secret: "SEGREDO-DO-ATLAS" });
});
atlas.use("/v1/previews/:id/open", async (c, next) => {
	// Login mínimo: só o dono com o cookie do Atlas chega ao /open.
	if (!c.req.header("cookie")?.includes("atlas_session=SEGREDO-DO-ATLAS")) return c.json({ error: "Unauthorized" }, 401);
	const date = new Date();
	c.set("session" as never, { user: { id: "dono", email: "d@t", name: "d", emailVerified: true, createdAt: date, updatedAt: date }, session: { id: "t", userId: "dono", token: "t", expiresAt: date, createdAt: date, updatedAt: date } } as never);
	await next();
});
atlas.route("/", createPreviewOpenRoutes(deps) as never);
atlas.route("/", createPreviewBasicRoutes(service) as never);
const server = serve({ fetch: atlas.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
const port = (server.address() as AddressInfo).port;
// `localhost` conta como contexto seguro: o Chromium aceita `SameSite=None; Secure` mesmo em http.
atlasUrl = `http://localhost:${port}`;
(deps.config as { atlasUrl: string }).atlasUrl = atlasUrl;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let failed = false;
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${atlasUrl}/login`);
	const response = await page.goto(`${atlasUrl}/v1/previews/${ID}/open`);
	await page.waitForFunction(() => document.title === "pronto", undefined, { timeout: 10_000 });
	const r = (await page.evaluate(() => (window as unknown as { __r: Record<string, string> }).__r))!;
	const csp = response?.headers()["content-security-policy"];
	const cookies = await context.cookies();
	console.log(JSON.stringify({ url: page.url(), csp, result: r, cookies: cookies.map((c) => ({ name: c.name, path: c.path, sameSite: c.sameSite, httpOnly: c.httpOnly, secure: c.secure })), atlasRequests: seenAtlas, subresource: await page.textContent("#sub") }, null, 2));

	assert.equal(page.url(), `${atlasUrl}${PREFIX}`, "terminou dentro do prefixo (nada de navegar o topo para o Atlas)");
	assert.equal(csp, "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
	assert.equal(r.origin, "null", "origem opaca");
	assert.match(r.cookie ?? "", /THROWS SecurityError/, "document.cookie lança em origem opaca");
	assert.match(r.localStorage ?? "", /THROWS SecurityError/, "localStorage lança (limitação documentada)");
	assert.equal(await page.textContent("#sub"), "subrecurso-ok", "subrecurso carrega com o cookie da prévia (SameSite=None)");
	assert.ok(seenAtlas.length >= 1, "a requisição para o mesmo host foi enviada");
	for (const req of seenAtlas) assert.ok(!req.cookie?.includes("atlas_session"), `a requisição ${req.path} NÃO leva o cookie de login (levou: ${req.cookie})`);
	assert.equal(r.fetchCors, "bloqueada pelo CORS", "a resposta de /v1/me não é legível pela página");
	const names = cookies.map((c) => c.name).sort();
	assert.deepEqual(names, ["atlas_preview", "atlas_session"], "o Set-Cookie do projeto (sid) foi descartado");
	const previewCookie = cookies.find((c) => c.name === PREVIEW_COOKIE)!;
	assert.equal(previewCookie.path, `/v1/previews/${ID}/`);
	assert.equal(previewCookie.httpOnly, true);
	assert.equal(previewCookie.sameSite, "None");
	console.log("\nOK: todos os itens passaram");
} catch (error) {
	failed = true;
	console.error("FALHOU:", error);
} finally {
	await browser.close();
	server.close();
	upstream.close();
}
process.exit(failed ? 1 : 0);
