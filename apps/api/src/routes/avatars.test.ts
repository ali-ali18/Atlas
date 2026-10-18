import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const sharp = (await import("sharp")).default;
const { createAvatarRoutes, createLru } = await import("./avatars.js");
const { requireUser } = await import("../middleware/auth.js");

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

test("serve o PNG 192x192 com cache imutável, sem sessão", async () => {
	const app = new Hono();
	app.use("/v1/*", requireUser);
	app.route("/", createAvatarRoutes());
	const res = await app.request("/v1/avatars/pebble-0086ff-v1.png");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/png");
	assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
	const body = Buffer.from(await res.arrayBuffer());
	assert.deepEqual([...body.subarray(0, 4)], PNG_MAGIC);
	const meta = await sharp(body).metadata();
	assert.equal(meta.width, 192);
	assert.equal(meta.height, 192);
	// Centro = corpo colorido; canto = fora do disco (transparente).
	const { data, info } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 4)];
	assert.equal(at(0, 0)[3], 0);
	assert.equal(at(96, 130)[3], 255);
	assert.deepEqual(at(96, 130).slice(0, 3), [0x00, 0x86, 0xff]);
	assert.deepEqual(at(10, 96).slice(0, 3), [0x09, 0x09, 0x0b]);
});

test("a segunda chamada vem do cache (mesmos bytes)", async () => {
	const app = createAvatarRoutes();
	const a = Buffer.from(await (await app.request("/v1/avatars/blob-ff6700-v1.png")).arrayBuffer());
	const b = Buffer.from(await (await app.request("/v1/avatars/blob-ff6700-v1.png")).arrayBuffer());
	assert.ok(a.equals(b));
});

test("chave inválida 400; sem .png 404", async () => {
	const app = createAvatarRoutes();
	for (const key of ["nope-0086ff-v1", "pebble-0086ff-v9", "pebble-xyz-v1", "pebble", "x".repeat(300)]) {
		assert.equal((await app.request(`/v1/avatars/${key}.png`)).status, 400, key);
	}
	assert.equal((await app.request("/v1/avatars/pebble-0086ff-v1")).status, 404);
	assert.equal((await app.request("/v1/avatars/pebble-0086ff-v1.svg")).status, 404);
});

test("as outras rotas /v1 continuam exigindo sessão", async () => {
	const app = new Hono();
	app.use("/v1/*", requireUser);
	app.get("/v1/avatars/a/b.png", (c) => c.text("x"));
	app.get("/v1/other", (c) => c.text("x"));
	assert.equal((await app.request("/v1/other")).status, 401);
	assert.equal((await app.request("/v1/avatars/a/b.png")).status, 401);
});

test("LRU descarta o menos usado", () => {
	const lru = createLru<number>(2);
	lru.set("a", 1);
	lru.set("b", 2);
	lru.get("a");
	lru.set("c", 3);
	assert.equal(lru.get("b"), undefined);
	assert.equal(lru.get("a"), 1);
	assert.equal(lru.size, 2);
});
