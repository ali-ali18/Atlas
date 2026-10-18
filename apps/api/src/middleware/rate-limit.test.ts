import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { rateLimitByIp } from "./rate-limit.js";

test("rate limit applies separately to each peer address", async () => {
	const app = new Hono();
	app.use("/stream", rateLimitByIp(2, 60_000));
	app.get("/stream", (c) => c.text("ok"));
	const request = (address: string) =>
		app.request("/stream", {}, {
			incoming: { socket: { remoteAddress: address, remotePort: 1234, remoteFamily: "IPv4" } },
		});

	assert.equal((await request("192.0.2.1")).status, 200);
	assert.equal((await request("192.0.2.1")).status, 200);
	const limited = await request("192.0.2.1");
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers.get("Retry-After")) > 0);
	assert.equal((await request("192.0.2.2")).status, 200);
});
