// Ditado por voz do composer: lógica pura (sem módulo nativo, sem React). Espelha `apps/web/lib/dictation.ts`: mesmos
// limites, mesma junção de texto e mesma máquina de estados. O reconhecimento é o nativo do aparelho (expo-speech-recognition);
// nada do que é falado vai ao servidor nem para log.

/** Teto do ditado: 2 minutos (igual ao web). */
export const MAX_DICTATION_MS = 120_000;
/** Silêncio depois da fala que encerra o ditado (igual ao web). */
export const SILENCE_STOP_MS = 2_000;
/** Se ninguém falar nada, desiste depois disso e não insere nada (igual ao web). */
export const NO_SPEECH_STOP_MS = 6_000;
/** Depois de pedir para parar, quanto esperar o resultado final antes de fechar com o que já chegou. */
export const FINALIZE_WAIT_MS = 1_500;

const SPEECH_LOCALES: Record<string, string> = { pt: "pt-BR", en: "en-US", es: "es-ES" };

/** Idioma curto do aparelho ("pt", "en", "es") → tag do reconhecimento; qualquer outro cai no pt-BR, o idioma do produto. */
export function speechLocaleFor(deviceCode: string | null | undefined): string {
	return SPEECH_LOCALES[(deviceCode ?? "").toLowerCase()] ?? "pt-BR";
}

/** Espaços repetidos e quebras viram um espaço só; pontas aparadas. */
export function collapseSpaces(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Primeira letra em maiúscula (só ela; não inventa pontuação nem mexe no resto). */
export function capitalizeFirst(text: string): string {
	return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** Anexa o texto ditado ao já digitado, separando por um espaço. Nunca apaga o que estava no campo. Em campo vazio, o texto começa em maiúscula. */
export function mergeDictation(current: string, dictated: string): string {
	const text = collapseSpaces(dictated);
	if (!text) return current;
	if (!current.trim()) return capitalizeFirst(text);
	return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

/**
 * O que o reconhecedor já entregou: `finals` = trechos confirmados, `partial` = o que ainda pode mudar. No Android
 * contínuo cada pausa fecha um trecho (isFinal) e o seguinte começa do zero, então os finais se acumulam.
 */
export type Transcript = { finals: string; partial: string };
export const EMPTY_TRANSCRIPT: Transcript = { finals: "", partial: "" };

function joinParts(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	return `${a} ${b}`;
}

export function applyResult(transcript: Transcript, result: { transcript: string; isFinal: boolean }): Transcript {
	const text = collapseSpaces(result.transcript);
	if (result.isFinal) return { finals: text ? joinParts(transcript.finals, text) : transcript.finals, partial: "" };
	return { finals: transcript.finals, partial: text };
}

/** Tudo o que foi falado até agora (finais + parcial). */
export function spokenText(transcript: Transcript): string {
	return joinParts(transcript.finals, transcript.partial);
}

export type DictationPhase = "idle" | "listening" | "stopping";
export type DictationEvent = "start" | "stop" | "silence" | "timeout" | "done" | "cancel" | "fail";

/** idle → listening → stopping (esperando o resultado final) → idle; cancelar ou falhar volta a idle de qualquer fase. */
export function dictationTransition(phase: DictationPhase, event: DictationEvent): DictationPhase {
	switch (event) {
		case "start":
			return phase === "idle" ? "listening" : phase;
		case "stop":
		case "silence":
		case "timeout":
			return phase === "listening" ? "stopping" : phase;
		case "done":
			return phase === "stopping" ? "idle" : phase;
		case "cancel":
		case "fail":
			return "idle";
	}
}

/**
 * Os três desfechos da barra de voz:
 * - `cancel`: descarta o falado, o campo fica como estava;
 * - `review`: o falado entra no campo (somado ao que havia) para revisar; também é o fim natural por silêncio;
 * - `send`: o falado entra e a mensagem segue direto (nada a enviar se o resultado for vazio).
 */
export type DictationOutcome = "cancel" | "review" | "send";

export function resolveDictation(outcome: DictationOutcome, current: string, spoken: string, maxLength = Number.POSITIVE_INFINITY): { text: string; send: boolean } {
	if (outcome === "cancel") return { text: current, send: false };
	const merged = mergeDictation(current, spoken);
	const text = merged.length > maxLength ? merged.slice(0, maxLength) : merged;
	return { text, send: outcome === "send" && text.trim().length > 0 };
}

/** Placeholder discreto da linha do meio da barra enquanto nada chegou. */
export const LISTENING_LABEL = "Ouvindo…";

/** Texto da linha do meio da barra: o que está sendo falado ou o placeholder. */
export function barLine(spoken: string): { text: string; empty: boolean } {
	const text = collapseSpaces(spoken);
	return text ? { text, empty: false } : { text: LISTENING_LABEL, empty: true };
}

/** Volume do reconhecedor (-2..10; abaixo de 0 é inaudível) → 0..1 para a altura das ondas. */
export function levelFraction(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(1, value / 10);
}

export type DictationProblem = "missing-module" | "unavailable" | "permission" | "failed";

/** Aviso amigável por problema. `settings`: oferece abrir as configurações do sistema. */
export function problemNotice(problem: DictationProblem): { message: string; settings: boolean } {
	switch (problem) {
		case "missing-module":
			return { message: "Voz disponível no app instalado.", settings: false };
		case "unavailable":
			return { message: "Este aparelho não tem reconhecimento de voz disponível.", settings: false };
		case "permission":
			return { message: "Permita o microfone e o reconhecimento de voz nas configurações para ditar.", settings: true };
		case "failed":
			return { message: "Não consegui ouvir agora. Tente de novo.", settings: false };
	}
}

/** Código de erro do reconhecedor → problema para o usuário; `null` = fim silencioso (nada a avisar). */
export function problemFromError(code: string): DictationProblem | null {
	switch (code) {
		case "no-speech":
		case "speech-timeout":
		case "aborted":
			return null;
		case "not-allowed":
			return "permission";
		case "service-not-allowed":
		case "language-not-supported":
			return "unavailable";
		default:
			return "failed";
	}
}
