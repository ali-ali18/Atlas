import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { offlineMessage, parseBootParams, probe, retryDelayMs } from "./connect.js";

describe("parseBootParams", () => {
	it("lê target e settings", () => {
		const p = parseBootParams("?target=https%3A%2F%2Fatlas.exemplo.com%2F&settings=C%3A%5Ccfg%5Csettings.json");
		assert.equal(p.target, "https://atlas.exemplo.com/");
		assert.equal(p.settingsPath, "C:\\cfg\\settings.json");
	});

	it("aceita http (dev local)", () => {
		assert.equal(parseBootParams("?target=http://localhost:3000").target, "http://localhost:3000/");
	});

	it("recusa esquemas que não são http(s)", () => {
		for (const bad of ["javascript:alert(1)", "file:///C:/Windows", "data:text/html,oi", "tauri://localhost"]) {
			assert.equal(parseBootParams(`?target=${encodeURIComponent(bad)}`).target, null, bad);
		}
	});

	it("recusa URL com credenciais, inválida, vazia ou longa demais", () => {
		assert.equal(parseBootParams("?target=https://u:p@atlas.exemplo.com").target, null);
		assert.equal(parseBootParams("?target=nao%20e%20url").target, null);
		assert.equal(parseBootParams("").target, null);
		assert.equal(parseBootParams(`?target=https://a.com/${"x".repeat(3000)}`).target, null);
	});

	it("settings vazio vira null", () => {
		assert.equal(parseBootParams("?settings=%20%20").settingsPath, null);
	});
});

describe("probe", () => {
	it("qualquer resposta conta como no ar e usa no-cors", async () => {
		let init: RequestInit | undefined;
		const r = await probe("https://a.com/", async (_u, i) => {
			init = i;
			return {};
		}, 1000);
		assert.deepEqual(r, { ok: true });
		assert.equal(init?.mode, "no-cors");
		assert.equal(init?.cache, "no-store");
	});

	it("erro de rede vira offline", async () => {
		const r = await probe("https://a.com/", async () => {
			throw new TypeError("Failed to fetch");
		}, 1000);
		assert.deepEqual(r, { ok: false, reason: "network" });
	});

	it("tempo esgotado aborta e vira timeout", async () => {
		const r = await probe(
			"https://a.com/",
			(_u, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
			10,
		);
		assert.deepEqual(r, { ok: false, reason: "timeout" });
	});
});

describe("retryDelayMs", () => {
	it("dobra a cada tentativa até 60s", () => {
		assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
	});

	it("entrada inválida volta ao início", () => {
		assert.equal(retryDelayMs(-3), 5000);
		assert.equal(retryDelayMs(Number.NaN), 5000);
	});
});

describe("offlineMessage", () => {
	it("tem texto pt-BR para cada motivo", () => {
		assert.match(offlineMessage("network"), /conexão/);
		assert.match(offlineMessage("timeout"), /demorou/);
		assert.match(offlineMessage("invalid-url"), /inválido/);
	});
});
