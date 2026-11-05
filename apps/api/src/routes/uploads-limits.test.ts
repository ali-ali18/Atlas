import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { jsonBodyLimit } from "../middleware/json-body-limit.js";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { createUploadRoutes } = await import("./uploads.js");

test("upload multipart de 9 MiB passa pelo middleware JSON e pela rota real", async () => {
	const now = new Date();
	const app = new Hono<AuthEnv>();
	let processedBytes = 0;
	let persistedOwner = "";
	app.use("*", jsonBodyLimit);
	app.use("*", async (c, next) => {
		c.set("session", {
			user: { id: "upload-limit-owner", name: "Owner", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now },
			session: { id: "s", token: "test", userId: "upload-limit-owner", expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
		});
		await next();
	});
	app.route("/", createUploadRoutes({
		// O teste cobre o transporte/envelope; o decoder tem testes próprios.
		processImage: async (bytes) => {
			processedBytes = bytes.byteLength;
			return { bytes: Buffer.from([1]), mime: "image/png", width: 1, height: 1 };
		},
		persistArtifact: async (input) => {
			persistedOwner = input.userId;
			return { id: "image-limit", kind: "image", meta: { mime: input.mime }, runId: null, conversationId: null, createdAt: now };
		},
	}));
	const bytes = new Uint8Array(9 * 1024 * 1024);
	bytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
	const form = new FormData();
	form.set("file", new File([bytes], "large.png", { type: "image/png" }));
	const response = await app.request("/v1/uploads/images", { method: "POST", body: form });
	assert.equal(response.status, 201);
	assert.equal(processedBytes, bytes.byteLength);
	assert.equal(persistedOwner, "upload-limit-owner");
	const excessive = new FormData();
	excessive.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
	assert.equal((await app.request("/v1/uploads/images", { method: "POST", body: excessive })).status, 413);
});

function appWithUploads(persisted: { bytes: number }) {
	const now = new Date();
	const app = new Hono<AuthEnv>();
	app.use("*", jsonBodyLimit);
	app.use("*", async (c, next) => {
		c.set("session", {
			user: { id: "upload-limit-owner", name: "Owner", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now },
			session: { id: "s", token: "test", userId: "upload-limit-owner", expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
		});
		await next();
	});
	app.route("/", createUploadRoutes({
		persistArtifact: async (input) => {
			persisted.bytes = input.bytes.byteLength;
			return { id: "file-limit", kind: "file", meta: { mime: input.mime }, runId: null, conversationId: null, createdAt: now };
		},
	}));
	app.post("/v1/runs", (c) => c.json({ ok: true }));
	return app;
}

function pdfForm(size: number) {
	const bytes = new Uint8Array(size);
	bytes.set(Buffer.from("%PDF-1.4\n"));
	const form = new FormData();
	form.set("file", new File([bytes], "grande.pdf", { type: "application/pdf" }));
	return form;
}

test("anexo de arquivo de ~2 MiB não recebe o 413 de JSON e chega na rota", async () => {
	const persisted = { bytes: 0 };
	const app = appWithUploads(persisted);
	const response = await app.request("/v1/uploads/files", { method: "POST", body: pdfForm(2 * 1024 * 1024) });
	assert.equal(response.status, 201);
	assert.equal(persisted.bytes, 2 * 1024 * 1024);
});

test("JSON comum acima de 1 MiB em outra rota /v1 continua 413", async () => {
	const app = appWithUploads({ bytes: 0 });
	const response = await app.request("/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) });
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { error: "JSON body exceeds 1 MiB" });
});

test("anexo acima de 20 MB continua 413, da rota e não do JSON", async () => {
	const persisted = { bytes: 0 };
	const app = appWithUploads(persisted);
	const response = await app.request("/v1/uploads/files", { method: "POST", body: pdfForm(21 * 1024 * 1024) });
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { error: "Arquivo maior que 20 MB" });
	assert.equal(persisted.bytes, 0);
});
