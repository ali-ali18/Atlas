import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyGithubSignature } from "./dispatch.js";

const SECRET = "s3cr3t-webhook";
const BODY = JSON.stringify({ hello: "world" });

function sign(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

test("verifyGithubSignature: assinatura válida passa", () => {
	assert.equal(verifyGithubSignature(SECRET, BODY, sign(SECRET, BODY)), true);
});

test("verifyGithubSignature: assinatura com secret errado falha", () => {
	assert.equal(verifyGithubSignature("outro-secret", BODY, sign(SECRET, BODY)), false);
});

test("verifyGithubSignature: body alterado depois de assinado falha", () => {
	const signature = sign(SECRET, BODY);
	assert.equal(verifyGithubSignature(SECRET, `${BODY}x`, signature), false);
});

test("verifyGithubSignature: header ausente falha", () => {
	assert.equal(verifyGithubSignature(SECRET, BODY, undefined), false);
});

test("verifyGithubSignature: header sem prefixo sha256= falha", () => {
	const raw = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
	assert.equal(verifyGithubSignature(SECRET, BODY, raw), false);
});

test("verifyGithubSignature: header com hex inválido não lança", () => {
	assert.equal(verifyGithubSignature(SECRET, BODY, "sha256=not-hex-zzz"), false);
});

test("verifyGithubSignature: header vazio falha", () => {
	assert.equal(verifyGithubSignature(SECRET, BODY, "sha256="), false);
});
