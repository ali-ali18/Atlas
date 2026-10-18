import assert from "node:assert/strict";
import test from "node:test";
import {
	dictationTransition,
	formatElapsed,
	mergeDictation,
	previewLabel,
	rmsLevel,
	speechLangFor,
	VOICE_LEVEL_THRESHOLD,
} from "./dictation";

test("idioma do bot vira BCP-47; desconhecido cai em pt-BR", () => {
	assert.equal(speechLangFor("pt-BR"), "pt-BR");
	assert.equal(speechLangFor("en-US"), "en-US");
	assert.equal(speechLangFor("es-ES"), "es-ES");
	assert.equal(speechLangFor(undefined), "pt-BR");
	assert.equal(speechLangFor("xx"), "pt-BR");
});

test("mergeDictation anexa com espaço e trata vazios", () => {
	assert.equal(mergeDictation("", "olá"), "olá");
	assert.equal(mergeDictation("   ", " olá "), "olá");
	assert.equal(mergeDictation("oi", "tudo bem"), "oi tudo bem");
	assert.equal(mergeDictation("oi ", "tudo"), "oi tudo");
	assert.equal(mergeDictation("oi", "  "), "oi");
});

test("previewLabel: Ouvindo… sem texto, nada em idle", () => {
	assert.equal(previewLabel("recording", ""), "Ouvindo…");
	assert.equal(previewLabel("recording", " abc "), "abc");
	assert.equal(previewLabel("transcribing", ""), "");
	assert.equal(previewLabel("idle", "abc"), "");
});

test("formatElapsed", () => {
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(65_900), "1:05");
	assert.equal(formatElapsed(120_000), "2:00");
});

test("rmsLevel: silêncio abaixo do limiar, voz acima", () => {
	assert.equal(rmsLevel([]), 0);
	assert.ok(rmsLevel(new Array(64).fill(128)) < VOICE_LEVEL_THRESHOLD);
	assert.ok(rmsLevel([128 + 60, 128 - 60, 128 + 60, 128 - 60]) > VOICE_LEVEL_THRESHOLD);
});

test("máquina de estados: caminho feliz, timeout, silêncio, cancel e fail", () => {
	assert.equal(dictationTransition("idle", "start"), "recording");
	assert.equal(dictationTransition("recording", "start"), "recording");
	assert.equal(dictationTransition("recording", "stop"), "transcribing");
	assert.equal(dictationTransition("recording", "timeout"), "transcribing");
	assert.equal(dictationTransition("recording", "silence"), "transcribing");
	assert.equal(dictationTransition("transcribing", "done"), "idle");
	assert.equal(dictationTransition("idle", "stop"), "idle");
	assert.equal(dictationTransition("transcribing", "start"), "transcribing");
	for (const phase of ["idle", "recording", "transcribing"] as const) {
		assert.equal(dictationTransition(phase, "cancel"), "idle");
		assert.equal(dictationTransition(phase, "fail"), "idle");
	}
});
