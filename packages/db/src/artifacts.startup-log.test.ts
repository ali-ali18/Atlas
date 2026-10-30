/** Aviso de inicialização do diretório de artefatos (api e worker). Função pura: sem disco nem banco. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { describeArtifactDir } = await import("./artifacts.js");

test("diretório configurado: só informa, mesmo em produção", () => {
	const result = describeArtifactDir({ ATLAS_ARTIFACT_DIR: "/data/artifacts", NODE_ENV: "production" });
	assert.equal(result.level, "info");
	assert.equal(result.fallback, false);
	assert.equal(result.dir, "/data/artifacts");
	assert.match(result.message, /ATLAS_ARTIFACT_DIR=\/data\/artifacts/);
});

test("sem a variável em produção: avisa alto que caiu para o tmpdir (fora do volume compartilhado)", () => {
	const result = describeArtifactDir({ NODE_ENV: "production" });
	assert.equal(result.level, "warn");
	assert.equal(result.fallback, true);
	assert.equal(result.dir, join(tmpdir(), "atlas-artifacts"));
	assert.match(result.message, /ATLAS_ARTIFACT_DIR não definido/);
	assert.match(result.message, /atlas-artifacts/);
});

test("variável só com espaços conta como ausente; fora de produção o fallback é só informativo", () => {
	assert.equal(describeArtifactDir({ ATLAS_ARTIFACT_DIR: "   ", NODE_ENV: "production" }).level, "warn");
	const dev = describeArtifactDir({});
	assert.equal(dev.level, "info");
	assert.equal(dev.fallback, true);
});
