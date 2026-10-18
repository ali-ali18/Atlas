import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { currentRequestId } from "@workspace/observability";
import { requestIdMiddleware } from "./request-id.js";

function app() {
	const a = new Hono();
	a.use("/*", requestIdMiddleware);
	a.get("/x", async (c) => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		return c.json({ inContext: currentRequestId() });
	});
	return a;
}

test("gera um request-id, devolve no header e o contexto o enxerga", async () => {
	const res = await app().request("/x");
	const id = res.headers.get("x-request-id");
	assert.ok(id && id.length >= 8);
	assert.deepEqual(await res.json(), { inContext: id });
});

test("reaproveita o x-request-id seguro do cliente", async () => {
	const res = await app().request("/x", { headers: { "x-request-id": "client-req-12345" } });
	assert.equal(res.headers.get("x-request-id"), "client-req-12345");
	assert.deepEqual(await res.json(), { inContext: "client-req-12345" });
});

test("descarta x-request-id malicioso e gera outro", async () => {
	const res = await app().request("/x", { headers: { "x-request-id": "evil id with spaces" } });
	const id = res.headers.get("x-request-id");
	assert.notEqual(id, "evil id with spaces");
	assert.ok(id && /^[A-Za-z0-9._:-]{8,64}$/.test(id));
});
