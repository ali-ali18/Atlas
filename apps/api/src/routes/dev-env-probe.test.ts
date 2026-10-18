import assert from "node:assert/strict";
import { test } from "node:test";
import { probeRepo } from "./dev-env-probe.js";

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("lê a raiz e só os arquivos de texto conhecidos; arquivo grande ou com erro é ignorado", async () => {
	const seen: string[] = [];
	const fetchFn = (async (url: string | URL | Request) => {
		const u = String(url);
		seen.push(u);
		if (u.endsWith("/contents/")) return jsonRes([{ name: "package.json" }, { name: "pnpm-lock.yaml" }, { name: "Makefile" }, { name: "README.md" }]);
		if (u.endsWith("package.json")) return new Response("{}", { status: 200 });
		if (u.endsWith("Makefile")) return new Response("x", { status: 200, headers: { "content-length": "999999" } });
		return new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	const result = await probeRepo("tok", "Acme/Site", fetchFn);
	assert.ok("probe" in result);
	if ("probe" in result) {
		assert.deepEqual(result.probe.rootFiles, ["package.json", "pnpm-lock.yaml", "Makefile", "README.md"]);
		assert.deepEqual(Object.keys(result.probe.texts), ["package.json"]);
	}
	assert.ok(seen.every((u) => u.includes("/repos/acme/site/contents")));
});

test("mapeia 403/404/rede e repositório inválido", async () => {
	const make = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
	assert.deepEqual(await probeRepo("t", "a/b", make(403)), { reason: "no_access" });
	assert.deepEqual(await probeRepo("t", "a/b", make(404)), { reason: "not_found" });
	assert.deepEqual(await probeRepo("t", "a/b", (async () => { throw new Error("rede"); }) as unknown as typeof fetch), { reason: "unavailable" });
	assert.deepEqual(await probeRepo("t", "nao e repo", make(200)), { reason: "invalid_repo" });
});
