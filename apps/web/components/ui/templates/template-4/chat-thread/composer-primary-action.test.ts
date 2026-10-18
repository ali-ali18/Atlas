import assert from "node:assert/strict";
import test from "node:test";
import { composerPrimaryAction, showSeparateMic, type ComposerDictationPhase } from "./composer-primary-action";

const phases: ComposerDictationPhase[] = ["idle", "recording", "transcribing"];

test("composerPrimaryAction: todas as combinações", () => {
	for (const runActive of [true, false])
		for (const hasContent of [true, false])
			for (const uploading of [true, false])
				for (const dictationSupported of [true, false])
					for (const dictationState of phases) {
						let expected: string;
						if (runActive) {
							expected = !hasContent && !uploading ? "stop" : !hasContent || uploading ? "send-disabled" : "send";
						} else if (dictationSupported && dictationState !== "idle") {
							expected = "dictating";
						} else if (!hasContent && !uploading && dictationSupported) {
							expected = "dictate";
						} else {
							expected = !hasContent || uploading ? "send-disabled" : "send";
						}
						assert.equal(
							composerPrimaryAction({ runActive, hasContent, uploading, dictationSupported, dictationState }),
							expected,
							JSON.stringify({ runActive, hasContent, uploading, dictationSupported, dictationState }),
						);
					}
});

test("composerPrimaryAction: casos-chave", () => {
	const base = { uploading: false, dictationSupported: true, dictationState: "idle" as const };
	assert.equal(composerPrimaryAction({ ...base, runActive: false, hasContent: false }), "dictate");
	assert.equal(composerPrimaryAction({ ...base, runActive: false, hasContent: false, dictationState: "recording" }), "dictating");
	assert.equal(composerPrimaryAction({ ...base, runActive: false, hasContent: true }), "send");
	assert.equal(composerPrimaryAction({ ...base, runActive: false, hasContent: false, dictationSupported: false }), "send-disabled");
	assert.equal(composerPrimaryAction({ ...base, runActive: true, hasContent: false, dictationState: "recording" }), "stop");
	assert.equal(composerPrimaryAction({ ...base, runActive: true, hasContent: true }), "send");
});

test("showSeparateMic: só com run ativo e ditado suportado", () => {
	assert.equal(showSeparateMic({ runActive: true, dictationSupported: true }), true);
	assert.equal(showSeparateMic({ runActive: true, dictationSupported: false }), false);
	assert.equal(showSeparateMic({ runActive: false, dictationSupported: true }), false);
	assert.equal(showSeparateMic({ runActive: false, dictationSupported: false }), false);
});
