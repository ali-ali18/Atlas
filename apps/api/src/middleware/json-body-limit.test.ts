import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { jsonBodyLimit } from "./json-body-limit.js";
import { API_INPUT_LIMITS } from "../chat/input-limits.js";

test("JSON acima de 1 MiB é rejeitado antes do efeito, com ou sem headers", async () => {
	const variants: Record<string, string>[] = [{}, { "Content-Type": "text/plain" }, { "Content-Length": "1" }, { "Content-Length": String(API_INPUT_LIMITS.jsonBytes + 1) }];
	for (const headers of variants) {
		let effects = 0;
		const app = new Hono();
		app.use("*", jsonBodyLimit);
		app.post("/v1/runs", (c) => { effects++; return c.json({ ok: true }); });
		const response = await app.request("/v1/runs", { method: "POST", headers, body: "x".repeat(API_INPUT_LIMITS.jsonBytes + 1) });
		assert.equal(response.status, 413);
		assert.equal(effects, 0);
	}
});

test("JSON chunked é limitado e JSON dentro do teto continua legível", async () => {
	const app = new Hono();
	app.use("*", jsonBodyLimit);
	app.post("/v1/runs", async (c) => c.json(await c.req.json()));
	const accepted = await app.request("/v1/runs", { method: "POST", body: '{"ok":true}' });
	assert.deepEqual(await accepted.json(), { ok: true });
	const body = new ReadableStream<Uint8Array>({ start(controller) {
		controller.enqueue(new Uint8Array(API_INPUT_LIMITS.jsonBytes));
		controller.enqueue(new Uint8Array(1));
		controller.close();
	} });
	const request = new Request("http://localhost/v1/runs", { method: "POST", body, duplex: "half" } as RequestInit);
	assert.equal((await app.request(request)).status, 413);
});
