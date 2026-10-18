import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScreenshotOptions, scrotPlan } from "./screenshot-options.mjs";

test("sem query: PNG integral", () => {
	assert.deepEqual(parseScreenshotOptions("/screenshot"), { jpeg: false, marks: false });
	assert.deepEqual(scrotPlan("/tmp/a", { jpeg: false }).args, ["--overwrite", "/tmp/a.png"]);
});

test("scalePct e quality viram JPEG reduzido com limites", () => {
	assert.deepEqual(parseScreenshotOptions("/screenshot?scalePct=80&quality=70"), {
		jpeg: true,
		marks: false,
		region: undefined,
		scalePct: 80,
		quality: 70,
	});
	assert.equal(parseScreenshotOptions("/screenshot?scalePct=1").scalePct, 10);
	assert.equal(parseScreenshotOptions("/screenshot?quality=999").quality, 95);
});

test("plano do scrot lê a miniatura quando reduz", () => {
	const plan = scrotPlan("/tmp/a", { jpeg: true, scalePct: 80, quality: 70 });
	assert.deepEqual(plan.args, ["--overwrite", "-q", "70", "-t", "80", "/tmp/a.jpg"]);
	assert.equal(plan.read, "/tmp/a-thumb.jpg");
	const full = scrotPlan("/tmp/a", { jpeg: true, scalePct: 100, quality: 70 });
	assert.equal(full.read, "/tmp/a.jpg");
	assert.ok(!full.args.includes("-t"));
});

import { parseRegion } from "./screenshot-options.mjs";
import { drawMarksInPage, withMarks } from "./marks.mjs";

test("region vira recorte do scrot (-a) em JPEG; inválida é ignorada", () => {
	assert.deepEqual(parseRegion("10,20,300,200"), { x: 10, y: 20, w: 300, h: 200 });
	assert.equal(parseRegion("10,20,3,200"), undefined);
	assert.equal(parseRegion("a,b,c,d"), undefined);
	assert.equal(parseRegion("-1,0,100,100"), undefined);
	assert.equal(parseRegion(null), undefined);
	const options = parseScreenshotOptions("/screenshot?region=10,20,300,200");
	assert.equal(options.jpeg, true);
	const plan = scrotPlan("/tmp/a", { ...options, scalePct: 100 });
	assert.deepEqual(plan.args.slice(0, 5), ["--overwrite", "-q", "70", "-a", "10,20,300,200"]);
});

test("marks=1 liga as marcas", () => {
	assert.equal(parseScreenshotOptions("/screenshot?marks=1").marks, true);
	assert.equal(parseScreenshotOptions("/screenshot").marks, false);
});

test("withMarks: tira snapshot, desenha, captura e sempre limpa", async () => {
	const calls = [];
	const page = { evaluate: async (fn) => (calls.push(fn === drawMarksInPage ? "draw" : "clear"), 3) };
	const result = await withMarks(
		{ withPageRetry: (fn) => fn(page), ensureRefs: async () => calls.push("snapshot") },
		async () => (calls.push("capture"), Buffer.from("x")),
	);
	assert.deepEqual(calls, ["snapshot", "draw", "capture", "clear"]);
	assert.equal(result.marks, 3);
});

test("withMarks limpa mesmo se a captura falhar", async () => {
	const calls = [];
	const page = { evaluate: async (fn) => (calls.push(fn === drawMarksInPage ? "draw" : "clear"), 1) };
	await assert.rejects(
		withMarks(
			{ withPageRetry: (fn) => fn(page), ensureRefs: async () => {} },
			async () => {
				throw new Error("scrot");
			},
		),
		/scrot/,
	);
	assert.deepEqual(calls, ["draw", "clear"]);
});
