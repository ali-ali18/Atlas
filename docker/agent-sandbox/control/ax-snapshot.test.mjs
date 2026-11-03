import test, { after } from "node:test";
import assert from "node:assert/strict";
import { AxUnavailableError, axEnabled, takeAxSnapshot } from "./ax-snapshot.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

test("flag ATLAS_AX_SNAPSHOT: ligada por padrão, off volta ao v1", () => {
	assert.equal(axEnabled({}), true);
	assert.equal(axEnabled({ ATLAS_AX_SNAPSHOT: "on" }), true);
	for (const value of ["off", "0", "false", "DOM"]) assert.equal(axEnabled({ ATLAS_AX_SNAPSHOT: value }), false, value);
});

test("usa ariaSnapshot mode ai com boxes", async () => {
	let seen;
	const page = { ariaSnapshot: async (options) => ((seen = options), "- generic [ref=e1]") };
	const result = await takeAxSnapshot(page);
	assert.equal(result.via, "ai");
	assert.equal(result.boxes, true);
	assert.equal(seen.mode, "ai");
	assert.equal(seen.boxes, true);
});

test("Playwright sem o modo ai cai em _snapshotForAI (sem boxes)", async () => {
	const page = {
		ariaSnapshot: async () => {
			throw new Error("options.mode: expected one of (default)");
		},
		_snapshotForAI: async () => ({ full: "- generic [ref=e1]" }),
	};
	const result = await takeAxSnapshot(page);
	assert.deepEqual([result.via, result.boxes], ["forAI", false]);
});

test("sem nenhuma API, lança unsupported para o chamador usar o v1", async () => {
	await assert.rejects(takeAxSnapshot({}), (error) => error instanceof AxUnavailableError && error.reason === "unsupported");
});

test("página lenta estoura o timeout curto e vira reason=timeout", async () => {
	const page = { ariaSnapshot: () => new Promise(() => {}) };
	await assert.rejects(takeAxSnapshot(page, { timeoutMs: 30 }), (error) => error.reason === "timeout");
});

test("falha real da página não vira unsupported", async () => {
	const page = {
		ariaSnapshot: async () => {
			throw new Error("Target page, context or browser has been closed");
		},
	};
	await assert.rejects(takeAxSnapshot(page), (error) => error.reason === "failed");
});

const fixture = await launchFixtureBrowser({
	"/": `<title>t</title><button>Ir</button><iframe srcdoc="<button>dentro</button>"></iframe>`,
});
after(async () => fixture?.close());

test("Chromium real: yaml com refs, boxes e iframe", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/`);
	const { yaml } = await takeAxSnapshot(page);
	assert.match(yaml, /button "Ir" \[ref=e\d+\] \[box=/);
	assert.match(yaml, /button "dentro" \[ref=f\d+e\d+\]/);
	await page.close();
});
