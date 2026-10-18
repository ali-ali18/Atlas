import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const sharp = (await import("sharp")).default;
const { Hono } = await import("hono");
const { createProfileRoutes } = await import("./profile.js");

type Row = { id: string; name: string; email: string; image: string | null };
function setup(sessionUserId = "u1") {
	const db = new Map<string, Row>([
		["u1", { id: "u1", name: "Ana", email: "a@t.l", image: null }],
		["u2", { id: "u2", name: "Bia", email: "b@t.l", image: null }],
	]);
	const calls: string[] = [];
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: sessionUserId }, session: {} });
		await next();
	});
	app.route("/", createProfileRoutes({
		updateProfile: async (userId, patch) => {
			calls.push(userId);
			const row = db.get(userId)!;
			if (patch.name !== undefined) row.name = patch.name;
			if (patch.image !== undefined) row.image = patch.image;
			return { ...row };
		},
	}));
	return { app, db, calls };
}
const json = (method: string, path: string, body: unknown) => ({ path, init: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
async function send(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, method: string, path: string, body: unknown) {
	const r = json(method, path, body);
	return app.request(r.path, r.init);
}
async function png(size: number, width = size, height = size) {
	return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer();
}
const dataUrl = (mime: string, bytes: Buffer | Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("nome: salva aparado, no usuário da sessão", async () => {
	const { app, db } = setup();
	const res = await send(app, "PATCH", "/v1/me", { name: "  Ana   Paula  " });
	assert.equal(res.status, 200);
	assert.equal((await res.json() as Row).name, "Ana Paula");
	assert.equal(db.get("u1")!.name, "Ana Paula");
	assert.equal(db.get("u2")!.name, "Bia");
});

test("nome: vazio, só espaços, longo demais ou não texto são recusados", async () => {
	const { app, calls } = setup();
	for (const name of ["", "   ", "x".repeat(61), 42, null, "a\u0000b"]) {
		assert.equal((await send(app, "PATCH", "/v1/me", { name })).status, 400, String(name));
	}
	assert.equal((await send(app, "PATCH", "/v1/me", "texto")).status, 400);
	assert.equal(calls.length, 0);
	assert.equal((await send(app, "PATCH", "/v1/me", { name: "x".repeat(60) })).status, 200);
});

test("só o próprio usuário altera: id/userId/email no corpo são ignorados", async () => {
	const { app, db, calls } = setup("u1");
	const res = await send(app, "PATCH", "/v1/me", { name: "Novo", id: "u2", userId: "u2", email: "x@x.x" });
	assert.equal(res.status, 200);
	assert.deepEqual(calls, ["u1"]);
	assert.equal(db.get("u2")!.name, "Bia");
	assert.equal(db.get("u1")!.email, "a@t.l");
	const other = setup("u2");
	await send(other.app, "PUT", "/v1/me/image", { image: dataUrl("image/png", await png(300)), userId: "u1" });
	assert.deepEqual(other.calls, ["u2"]);
	assert.equal(other.db.get("u1")!.image, null);
});

test("foto: reduz para 256x256 WebP, recorta o centro e guarda abaixo de 60 KB", async () => {
	const { app, db } = setup();
	const res = await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/png", await png(0, 900, 500)) });
	assert.equal(res.status, 200);
	const image = db.get("u1")!.image!;
	assert.match(image, /^data:image\/webp;base64,/);
	const bytes = Buffer.from(image.split(",")[1]!, "base64");
	assert.ok(bytes.length <= 60 * 1024);
	const meta = await sharp(bytes).metadata();
	assert.equal(meta.format, "webp");
	assert.equal(meta.width, 256);
	assert.equal(meta.height, 256);
});

test("foto: recusa SVG, GIF, texto qualquer e dados que não são imagem", async () => {
	const { app, calls } = setup();
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/svg+xml", svg) })).status, 415);
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/gif", await png(10)) })).status, 415);
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: "https://exemplo.com/a.png" })).status, 415);
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: 5 })).status, 400);
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/png", svg) })).status, 415, "tipo declarado png mas conteúdo é SVG");
	assert.equal(calls.length, 0);
});

test("foto: recusa imagem grande demais", async () => {
	const { app, calls } = setup();
	const noisy = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 0, g: 0, b: 0 }, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png().toBuffer();
	assert.ok(noisy.length > 120 * 1024);
	assert.equal((await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/png", noisy) })).status, 413);
	assert.equal(calls.length, 0);
});

test("remover a foto devolve image null", async () => {
	const { app, db } = setup();
	await send(app, "PUT", "/v1/me/image", { image: dataUrl("image/png", await png(64)) });
	assert.ok(db.get("u1")!.image);
	const res = await app.request("/v1/me/image", { method: "DELETE" });
	assert.equal(res.status, 200);
	assert.equal((await res.json() as Row).image, null);
	assert.equal(db.get("u1")!.image, null);
});
