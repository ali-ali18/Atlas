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
