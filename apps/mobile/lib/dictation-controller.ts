// Controlador do ditado: liga a lógica pura (`dictation.ts`) ao reconhecedor nativo, tudo por injeção (testável sem celular).
// Mesmo desenho do `apps/web/lib/dictation-controller.ts`: prévia ao vivo, silêncio de 2 s encerra, 6 s sem fala desiste,
// teto de 2 min. Não grava nem registra áudio ou texto.
import {
	EMPTY_TRANSCRIPT,
	FINALIZE_WAIT_MS,
	MAX_DICTATION_MS,
	NO_SPEECH_STOP_MS,
	SILENCE_STOP_MS,
	applyResult,
	dictationTransition,
	problemFromError,
	spokenText,
	type DictationEvent,
	type DictationOutcome,
	type DictationPhase,
	type DictationProblem,
	type Transcript,
} from "./dictation";

/** O que o controlador precisa do módulo nativo (o adaptador real fica em `speech-native.ts`). */
export type SpeechEngine = {
	available(): boolean;
	supportsOnDevice(): boolean;
	requestPermissions(): Promise<{ granted: boolean }>;
	start(options: { lang: string; onDevice: boolean }): void;
	stop(): void;
	abort(): void;
	onResult(listener: (result: { transcript: string; isFinal: boolean }) => void): () => void;
	onSpeechStart(listener: () => void): () => void;
	onVolume(listener: (value: number) => void): () => void;
	onEnd(listener: () => void): () => void;
	onError(listener: (code: string) => void): () => void;
};

export type DictationTimers = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
};

export type DictationView = { phase: DictationPhase; spoken: string; level: number };

export type DictationOptions = {
	/** `null` = sem módulo nativo (Expo Go): o ditado avisa em vez de quebrar. */
	engine: SpeechEngine | null;
	timers: DictationTimers;
	language: string;
	onChange: (view: DictationView) => void;
	/** Fim do ditado: o desfecho e o que foi falado. */
	onFinish: (result: { outcome: DictationOutcome; spoken: string }) => void;
	onProblem: (problem: DictationProblem) => void;
};

export function createDictationController(options: DictationOptions) {
	const { engine, timers } = options;
	let phase: DictationPhase = "idle";
	let transcript: Transcript = EMPTY_TRANSCRIPT;
	let level = 0;
	let outcome: DictationOutcome = "review";
	let session = 0;
	let onDevice = false;
	let retriedOnline = false;
	let removers: Array<() => void> = [];
	let maxTimer: unknown = null;
	let silenceTimer: unknown = null;
	let finalizeTimer: unknown = null;

	const currentPhase = (): DictationPhase => phase;
	const emit = () => options.onChange({ phase, spoken: spokenText(transcript), level });
	const move = (event: DictationEvent) => {
		phase = dictationTransition(phase, event);
	};

	function clearTimers() {
		for (const id of [maxTimer, silenceTimer, finalizeTimer]) if (id !== null) timers.clearTimeout(id);
		maxTimer = silenceTimer = finalizeTimer = null;
	}

	function detach() {
		clearTimers();
		for (const remove of removers) remove();
		removers = [];
	}

	function abortQuietly() {
		try {
			engine?.abort();
		} catch {
			// já parado
		}
	}

	function armSilence(ms: number) {
		if (silenceTimer !== null) timers.clearTimeout(silenceTimer);
		silenceTimer = timers.setTimeout(() => finish("review", "silence"), ms);
	}

	/** Pede ao reconhecedor para fechar e espera o resultado final; `finalize` entrega o que chegou. */
	function finish(next: DictationOutcome, event: "stop" | "silence" | "timeout") {
		if (phase !== "listening") return;
		outcome = next;
		move(event);
		for (const id of [silenceTimer, maxTimer]) if (id !== null) timers.clearTimeout(id);
		silenceTimer = maxTimer = null;
		emit();
		try {
			engine?.stop();
		} catch {
			finalize();
			return;
		}
		finalizeTimer = timers.setTimeout(finalize, FINALIZE_WAIT_MS);
	}

	function finalize() {
		if (phase !== "stopping") return;
		const spoken = spokenText(transcript);
		const chosen = outcome;
		detach();
		move("done");
		transcript = EMPTY_TRANSCRIPT;
		level = 0;
		emit();
		options.onFinish({ outcome: chosen, spoken });
	}

	/** Fim espontâneo (o sistema encerrou ou deu erro depois de ouvir algo): vai para revisão. */
	function endNaturally() {
		if (phase === "listening") {
			outcome = "review";
			move("silence");
			emit();
		}
		finalize();
	}

	let language = options.language;

	function begin(mine: number) {
		if (!engine) return;
		try {
			engine.start({ lang: language, onDevice });
		} catch {
			if (mine !== session) return;
			detach();
			move("fail");
			emit();
			options.onProblem("failed");
			return;
		}
		if (maxTimer === null) maxTimer = timers.setTimeout(() => finish("review", "timeout"), MAX_DICTATION_MS);
		armSilence(NO_SPEECH_STOP_MS);
	}

	function listen(mine: number) {
		if (!engine) return;
		removers = [
			engine.onResult((result) => {
				// Depois de parar ainda chega o resultado final: ele entra, só não rearma o silêncio.
				if (mine !== session || phase === "idle") return;
				transcript = applyResult(transcript, result);
				if (phase === "listening") armSilence(SILENCE_STOP_MS);
				emit();
			}),
			// Voz detectada: rearma o silêncio mesmo antes de o texto chegar.
			engine.onSpeechStart(() => {
				if (mine === session && phase === "listening") armSilence(SILENCE_STOP_MS);
			}),
			engine.onVolume((value) => {
				if (mine !== session || phase !== "listening") return;
				level = value;
				emit();
			}),
			// O sistema encerra sozinho após o silêncio: mesmo efeito de "parar e revisar".
			engine.onEnd(() => {
				if (mine === session) endNaturally();
			}),
			engine.onError((code) => {
				if (mine !== session || phase === "idle") return;
				// Modelo no aparelho ausente para o idioma: tenta uma vez com o serviço do sistema.
				if (code === "language-not-supported" && onDevice && !retriedOnline && spokenText(transcript) === "") {
					retriedOnline = true;
					onDevice = false;
					detach();
					listen(mine);
					begin(mine);
					return;
				}
				// Já falou algo, ou o usuário já pediu para parar: o texto não se perde (vai para revisão) e erro tardio
				// ("no-speech", "client", "aborted"...) não vira aviso. O motor costuma emitir `error` junto do `end`.
				if (spokenText(transcript) !== "" || phase === "stopping") {
					endNaturally();
					return;
				}
				const problem = problemFromError(code);
				if (problem) options.onProblem(problem);
				abortQuietly();
				detach();
				move("fail");
				transcript = EMPTY_TRANSCRIPT;
				level = 0;
				emit();
			}),
		];
	}

	async function start(languageTag?: string) {
		if (phase !== "idle") return;
		if (!engine) return options.onProblem("missing-module");
		if (!engine.available()) return options.onProblem("unavailable");
		session += 1;
		const mine = session;
		language = languageTag ?? options.language;
		transcript = EMPTY_TRANSCRIPT;
		level = 0;
		outcome = "review";
		retriedOnline = false;
		move("start");
		emit();
		let granted = false;
		try {
			granted = (await engine.requestPermissions()).granted;
		} catch {
			granted = false;
		}
		if (mine !== session || currentPhase() !== "listening") return;
		if (!granted) {
			move("fail");
			emit();
			options.onProblem("permission");
			return;
		}
		onDevice = engine.supportsOnDevice();
		listen(mine);
		begin(mine);
		emit();
	}

	/** Parar de ouvir: `review` leva o texto ao campo, `send` envia direto. */
	function stop(next: "review" | "send" = "review") {
		finish(next, "stop");
	}

	/** X: descarta o falado; o campo fica como estava. */
	function cancel() {
		if (phase === "idle") return;
		session += 1;
		abortQuietly();
		detach();
		move("cancel");
		transcript = EMPTY_TRANSCRIPT;
		level = 0;
		emit();
		options.onFinish({ outcome: "cancel", spoken: "" });
	}

	return { start, stop, cancel, getView: (): DictationView => ({ phase, spoken: spokenText(transcript), level }) };
}

export type DictationController = ReturnType<typeof createDictationController>;
