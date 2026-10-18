import assert from "node:assert/strict";
import test from "node:test";
import { imageFileUrl } from "./image-url";

test("URL da imagem usa apenas endpoint autenticado local", () => {
	assert.equal(imageFileUrl("abc"), "/v1/files/abc");
	assert.equal(imageFileUrl("a/b", true), "/v1/files/a%2Fb?download=1");
});
