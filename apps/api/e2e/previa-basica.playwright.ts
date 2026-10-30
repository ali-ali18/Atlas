/**
 * Prova no Chromium de que a prévia do modo básico roda em origem opaca, não alcança o login do Atlas e, mesmo assim, carrega o que
 * um build do Vite precisa: <script type="module" crossorigin>, modulepreload, stylesheet/fonte crossorigin e fetch('./data.json').
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
import { basicResponseHeaders, createPreviewBasicRoutes, createPreviewOpenRoutes, createPreviewService } from "../src/routes/previews.js";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const ID = "cmabc123def456ghi789jkl01";
const CAP = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PREFIX = `/v1/previews/${ID}/p/${CAP}/`;
const seenAtlas: Array<{ path: string; cookie: string | undefined }> = [];

// Projeto "do usuário", no estilo de um build do Vite: caminhos relativos, módulo crossorigin, modulepreload, fonte e fetch.
const upstream = http.createServer((req, res) => {
	res.setHeader("Set-Cookie", "sid=1; Path=/");
	const path = (req.url ?? "/").split("?")[0]!;
	const send = (type: string, body: string | Buffer) => {
		res.setHeader("Content-Type", type);
		res.end(body);
	};
	if (path === "/m.js") return send("text/javascript", "import './m2.js'; window.__mod = 'module-ok'; document.getElementById('mod').textContent = 'module-ok';");
	if (path === "/m2.js") return send("text/javascript", "window.__m2 = 'dep-ok';");
	if (path === "/s.css") return send("text/css", "@font-face{font-family:T;src:url(./f.woff2) format('woff2')} body{font-family:T,sans-serif}");
	if (path === "/f.woff2") return send("font/woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32]));
	if (path === "/data.json") return send("application/json", JSON.stringify({ ok: true }));
	send("text/html", `<!doctype html><html><head>
<link rel="modulepreload" crossorigin href="./m2.js">
<link rel="stylesheet" crossorigin href="./s.css">
<link rel="preload" as="font" type="font/woff2" crossorigin href="./f.woff2">
<script type="module" crossorigin src="./m.js"></script>
</head><body><p id="mod">pendente</p><script>
// self.origin (origem do documento) é o que vale null no sandbox; location.origin vem da URL.
const r = { origin: self.origin, locationOrigin: location.origin };
try { r.cookie = 'len=' + document.cookie.length; } catch (e) { r.cookie = 'THROWS ' + e.name; }
try { localStorage.setItem('x', '1'); r.localStorage = 'ok'; } catch (e) { r.localStorage = 'THROWS ' + e.name; }
Promise.allSettled([
  fetch('./data.json').then((x) => x.json()),
  fetch('/v1/me?same-host', { mode: 'no-cors' }).then(() => 'enviada'),
  fetch('/v1/me?cors').then((x) => x.text()),
  fetch('/v1/me?cors-creds', { credentials: 'include' }).then((x) => x.text()),
]).then((all) => {
  r.dataJson = all[0].status === 'fulfilled' ? JSON.stringify(all[0].value) : 'FALHOU ' + all[0].reason;
  r.fetchNoCors = all[1].status;
  r.fetchCors = all[2].status === 'rejected' ? 'bloqueada pelo CORS' : 'LEU: ' + all[2].value;
  r.fetchCorsCreds = all[3].status === 'rejected' ? 'bloqueada pelo CORS' : 'LEU: ' + all[3].value;
  window.__r = r; document.title = 'pronto';
});
</script></body></html>`);
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as AddressInfo).port;

const atlas = new Hono();
const record = { id: ID, userId: "dono", conversationId: "c", repo: null, branch: null, baseBranch: null, status: "RUNNING", tier: "small", containerId: "x", todos: [], pr: null, lastError: null, createdAt: new Date(), updatedAt: new Date(), lastActiveAt: new Date(), preview: { port: upstreamPort, path: "/", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cap: CAP } } as never;
const deps = {
	config: { baseDomain: null, scheme: "http" as const, atlasUrl: "", secret: "segredo-e2e" },
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
atlas.use("/v1/previews/:id/p/*", basicResponseHeaders);
atlas.route("/", createPreviewOpenRoutes(deps) as never);
atlas.route("/", createPreviewBasicRoutes(service) as never);
const server = serve({ fetch: atlas.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
const port = (server.address() as AddressInfo).port;
(deps.config as { atlasUrl: string }).atlasUrl = `http://localhost:${port}`;
const atlasUrl = `http://localhost:${port}`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let failed = false;
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	const failedRequests: string[] = [];
	const statuses: Record<string, number> = {};
	page.on("requestfailed", (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText}`));
	page.on("response", (res) => {
		const path = new URL(res.url()).pathname;
		if (path.startsWith(PREFIX)) statuses[path.slice(PREFIX.length) || "/"] = res.status();
	});
	await page.goto(`${atlasUrl}/login`);
	const response = await page.goto(`${atlasUrl}/v1/previews/${ID}/open`);
	await page.waitForFunction(() => document.title === "pronto", undefined, { timeout: 10_000 });
	const r = (await page.evaluate(() => (window as unknown as { __r: Record<string, string> }).__r))!;
	const csp = response?.headers()["content-security-policy"];
	const cookies = await context.cookies();
	const flags = await page.evaluate(() => ({ mod: (window as never as Record<string, string>).__mod, dep: (window as never as Record<string, string>).__m2 }));
	console.log(JSON.stringify({ url: page.url().replace(CAP, "<cap>"), csp, result: r, flags, statuses, failedRequests, cookies: cookies.map((c) => ({ name: c.name, path: c.path })), atlasRequests: seenAtlas }, null, 2));

	assert.equal(page.url(), `${atlasUrl}${PREFIX}`, "terminou dentro do prefixo");
	assert.equal(csp, "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
	assert.equal(r.origin, "null", "origem opaca");
	assert.match(r.cookie ?? "", /THROWS SecurityError/, "document.cookie lança em origem opaca");
	assert.match(r.localStorage ?? "", /THROWS SecurityError/, "localStorage lança (limitação documentada)");
	// Estilo Vite: tudo carrega mesmo sendo CORS anônimo (a origem opaca não leva cookie).
	assert.equal(flags.mod, "module-ok", "<script type=module crossorigin> carregou e executou");
	assert.equal(flags.dep, "dep-ok", "dependência do módulo (modulepreload) carregou");
	for (const file of ["m.js", "m2.js", "s.css", "f.woff2", "data.json"]) assert.equal(statuses[file], 200, `${file} respondeu 200`);
	assert.deepEqual(failedRequests.filter((f) => f.includes(PREFIX)), [], "nenhuma requisição da prévia falhou (CORS)");
	assert.ok(failedRequests.filter((f) => f.includes("/v1/me")).length >= 2, "as leituras CORS de /v1/me (Atlas) falham, como deve ser");
	assert.equal(r.dataJson, '{"ok":true}', "fetch('./data.json') com CORS lê a resposta");
	// Atlas: o pedido para o mesmo host chega SEM o cookie de login e a resposta não é legível.
	assert.ok(seenAtlas.length >= 1, "a requisição para o mesmo host foi enviada");
	for (const req of seenAtlas) assert.ok(!req.cookie?.includes("atlas_session"), `a requisição ${req.path} NÃO leva o cookie de login (levou: ${req.cookie})`);
	assert.equal(r.fetchCors, "bloqueada pelo CORS", "a resposta de /v1/me não é legível pela página");
	assert.equal(r.fetchCorsCreds, "bloqueada pelo CORS", "nem com credentials:include");
	// Sem cookie de prévia, e o Set-Cookie do projeto (sid) foi descartado.
	assert.deepEqual(cookies.map((c) => c.name), ["atlas_session"]);
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
