import { describe, expect, it } from "vitest";
import { CACHE_PROBE_SCRIPT, CACHE_RESTORE_SCRIPT, CACHE_SAVE_SCRIPT, CACHE_WIPE_SCRIPT, cacheNote, cacheStateOf, parseCacheProbe } from "./dev-env-cache.js";

describe("sonda do cache", () => {
	it("lê volume, runtime, lockfiles e metadados", () => {
		const meta = JSON.stringify({ key: "k", parts: { install: "a", lock: "b", runtime: "c", env: "d" }, savedAt: 5 });
		const out = ["writable=1", "runtime=2 v22.1.0 x86_64", "lock=abc", `saved=${meta}`].join(String.fromCharCode(10));
		const probe = parseCacheProbe(out);
		expect(probe).toMatchObject({ writable: true, runtime: "2 v22.1.0 x86_64", lockHash: "abc" });
		expect(probe.saved?.key).toBe("k");
	});
	it("saída vazia ou lixo vira cache indisponível", () => {
		expect(parseCacheProbe("")).toMatchObject({ writable: false, saved: null, lockHash: "none" });
		expect(parseCacheProbe("writable=1\nsaved={nao-json").saved).toBeNull();
	});
	it("estado do passo e nota ao modelo", () => {
		expect(cacheStateOf("off")).toBeUndefined();
		expect(cacheStateOf("stale")).toBe("stale");
		expect(cacheNote("hit", "pnpm install")).toContain("restauradas do cache");
		expect(cacheNote("miss", "pnpm install")).toBe("");
	});
});

describe("scripts do cache", () => {
	const scripts = { CACHE_PROBE_SCRIPT, CACHE_RESTORE_SCRIPT, CACHE_SAVE_SCRIPT, CACHE_WIPE_SCRIPT };
	it("não têm bytes de controle (escape corrompido) nem tocam em arquivos .env", () => {
		for (const [name, script] of Object.entries(scripts)) {
			expect(script.includes(String.fromCharCode(8)), name).toBe(false);
			expect(script, name).not.toMatch(/\.env/);
		}
	});
	it("só arquivam node_modules/.venv ignorados pelo git", () => {
		expect(CACHE_SAVE_SCRIPT).toContain("git check-ignore");
		expect(CACHE_SAVE_SCRIPT).toContain("node_modules");
	});
	it("a sonda cobre os lockfiles pedidos", () => {
		for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "poetry.lock", "uv.lock", "requirements*.txt", "Cargo.lock", "go.sum"]) {
			expect(CACHE_PROBE_SCRIPT).toContain(name);
		}
	});
});
