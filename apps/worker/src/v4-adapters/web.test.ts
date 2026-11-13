/**
 * Busca e leitura de página do v4 no worker: o adaptador do pacote recebe a busca e a extração por injeção.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/web.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createV4Search, realV4WebDeps } from "./web.js";

test("busca pelo SearXNG injetado e lê a página pela extração injetada", async () => {
	const seen: string[] = [];
	const search = createV4Search({
		searxng: async (query) => {
			seen.push(query);
			return [{ url: "https://example.test/a", title: "A", snippet: "resumo" }];
		},
		extract: async (url) => ({ url, title: "Página", markdown: "# Texto", truncated: false }),
	});
	const hits = await search.search("user-a", "atlas");
	assert.deepEqual(seen, ["atlas"]);
	assert.equal(hits[0]?.url, "https://example.test/a");
	const page = await search.extract("user-a", "https://example.test/a");
	assert.match(JSON.stringify(page), /# Texto/);
});

test("SSRF: endereço interno é barrado antes da extração", async () => {
	let extracted = 0;
	const search = createV4Search({ extract: async (url) => ((extracted += 1), { url, markdown: "x", truncated: false }) });
	await assert.rejects(search.extract("user-a", "http://169.254.169.254/latest/meta-data"));
	await assert.rejects(search.extract("user-a", "http://localhost:8080/"));
	assert.equal(extracted, 0);
});

test("dependências reais: SearXNG só entra com a URL configurada", () => {
	assert.equal(realV4WebDeps({}).searxng, undefined);
	assert.equal(typeof realV4WebDeps({ SEARXNG_BASE_URL: "http://searx.internal" }).searxng, "function");
});

test("a busca pede páginas no idioma do run, sem idioma fixo (auditoria F2, R5)", async () => {
	const headers: string[] = [];
	const fetchFn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
		headers.push(init?.headers?.["Accept-Language"] ?? "");
		return new Response("<html></html>", { status: 200 });
	}) as never;
	const extract = async (url: string) => ({ url, title: "", markdown: "", truncated: false });
	await createV4Search({ extract, fetchFn }, "es-ES").search("user-a", "hola").catch(() => undefined);
	await createV4Search({ extract, fetchFn }).search("user-a", "hello").catch(() => undefined);
	assert.match(headers[0] ?? "", /^es-ES/);
	assert.match(headers[1] ?? "", /^en/);
});
