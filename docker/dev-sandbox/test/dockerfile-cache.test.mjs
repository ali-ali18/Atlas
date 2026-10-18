import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("/envcache existe na imagem e pertence ao usuário dev (o volume herda o dono)", () => {
	assert.match(dockerfile, /mkdir -p [^\n]*\/envcache/);
	assert.match(dockerfile, /chown -R dev:dev [^\n]*\/envcache/);
});

test("a imagem declara a versão (entra na chave do cache) e os caches de cada gerenciador em /cache", () => {
	assert.match(dockerfile, /DEV_IMAGE_VERSION=\d+/);
	for (const name of ["CARGO_HOME", "UV_CACHE_DIR", "GOMODCACHE", "YARN_CACHE_FOLDER", "BUN_INSTALL_CACHE_DIR"]) {
		assert.ok(dockerfile.includes(`${name}=/cache/`), name);
	}
});
