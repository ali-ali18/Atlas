export type ComposerPrimaryAction =
	| "dictate"
	| "dictating"
	| "send"
	| "send-disabled"
	| "stop";

export type ComposerDictationPhase = "idle" | "recording" | "transcribing";

/**
 * Decisão pura do botão principal do compositor.
 * - run ativo: vazio vira "parar"; com conteúdo é envio (o ditado tem botão à parte).
 * - sem run e vazio: o próprio botão é o ditado (ou envio desabilitado sem suporte).
 * - sem run e com conteúdo: envio normal.
 */
export function composerPrimaryAction({
	runActive,
	hasContent,
	uploading,
	dictationSupported = false,
	dictationState = "idle",
}: {
	runActive: boolean;
	hasContent: boolean;
	uploading: boolean;
	dictationSupported?: boolean;
	dictationState?: ComposerDictationPhase;
}): ComposerPrimaryAction {
	if (runActive) {
		if (!hasContent && !uploading) return "stop";
		return !hasContent || uploading ? "send-disabled" : "send";
	}
	if (dictationSupported && dictationState !== "idle") return "dictating";
	if (!hasContent && !uploading && dictationSupported) return "dictate";
	if (!hasContent || uploading) return "send-disabled";
	return "send";
}

/** Botão de microfone separado só existe com run ativo (sem run, o principal já é o ditado). */
export function showSeparateMic({
	runActive,
	dictationSupported,
}: {
	runActive: boolean;
	dictationSupported: boolean;
}): boolean {
	return runActive && dictationSupported;
}
