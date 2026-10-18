import type { BotLanguage } from "@workspace/shared";

/** Teto do ditado: 2 minutos. */
export const MAX_DICTATION_MS = 120_000;
/** Silêncio depois da fala que encerra o ditado. */
export const SILENCE_STOP_MS = 2_000;
/** Se ninguém falar nada, desiste depois disso (insere nada). */
export const NO_SPEECH_STOP_MS = 6_000;
/** Nível RMS (0..1) acima do qual há voz. */
export const VOICE_LEVEL_THRESHOLD = 0.02;

const SPEECH_LANGS: Record<BotLanguage, string> = {
	"pt-BR": "pt-BR",
	"en-US": "en-US",
	"es-ES": "es-ES",
};

/** Idioma do bot -> tag BCP-47 do reconhecimento de fala (padrão pt-BR). */
export function speechLangFor(language: string | null | undefined): string {
	return SPEECH_LANGS[language as BotLanguage] ?? "pt-BR";
}

/** Anexa o texto ditado ao já digitado, separando por um espaço. */
export function mergeDictation(current: string, dictated: string): string {
	const text = dictated.trim();
	if (!text) return current;
	if (!current.trim()) return text;
	return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

export type DictationPhase = "idle" | "recording" | "transcribing";
export type DictationEvent = "start" | "stop" | "timeout" | "silence" | "done" | "cancel" | "fail";

/** Texto que aparece como prévia dentro do campo (nunca entra no valor). */
export function previewLabel(phase: DictationPhase, preview: string): string {
	if (phase === "idle") return "";
	if (preview.trim()) return preview.trim();
	return phase === "recording" ? "Ouvindo…" : "";
}

/** Tempo decorrido como m:ss. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** RMS 0..1 de amostras de domínio de tempo (bytes 0..255, 128 = silêncio). */
export function rmsLevel(samples: ArrayLike<number>): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = (samples[i]! - 128) / 128;
		sum += v * v;
	}
	return Math.sqrt(sum / samples.length);
}

/** Máquina de estados: idle -> recording -> transcribing -> idle; cancel/fail voltam a idle de qualquer fase. */
export function dictationTransition(phase: DictationPhase, event: DictationEvent): DictationPhase {
	switch (event) {
		case "start":
			return phase === "idle" ? "recording" : phase;
		case "stop":
		case "timeout":
		case "silence":
			return phase === "recording" ? "transcribing" : phase;
		case "done":
			return phase === "transcribing" ? "idle" : phase;
		case "cancel":
		case "fail":
			return "idle";
	}
}
