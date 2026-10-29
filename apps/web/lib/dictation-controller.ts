import {
	MAX_DICTATION_MS,
	NO_SPEECH_STOP_MS,
	SILENCE_STOP_MS,
	VOICE_LEVEL_THRESHOLD,
	dictationTransition,
	speechLangFor,
	type DictationEvent,
	type DictationPhase,
} from "./dictation";
import { activeT } from "@/lib/i18n/active";

/** Subconjunto das APIs de navegador que o ditado usa (injetável nos testes). */
export type SpeechResultLike = { isFinal: boolean; 0: { transcript: string } };
export type SpeechRecognitionLike = {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((event: { results: ArrayLike<SpeechResultLike> }) => void) | null;
	onend: (() => void) | null;
	onerror: ((event: { error?: string }) => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};
export type MediaRecorderLike = {
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null;
	onstop: (() => void) | null;
	start(): void;
	stop(): void;
};
export type StreamLike = { getTracks(): Array<{ stop(): void }> };
export type LevelMeter = { read(): number; close(): void };

export type DictationDeps = {
	createRecognition: (() => SpeechRecognitionLike) | null;
	getUserMedia: (() => Promise<StreamLike>) | null;
	createRecorder: ((stream: StreamLike) => MediaRecorderLike) | null;
	createLevelMeter?: ((stream: StreamLike) => LevelMeter) | null;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
	setInterval: (fn: () => void, ms: number) => unknown;
	clearInterval: (id: unknown) => void;
	now: () => number;
};

export type DictationView = {
	phase: DictationPhase;
	preview: string;
	elapsedMs: number;
};

export type DictationOptions = {
	deps: DictationDeps;
	language?: string | null;
	/** Transcrição precisa no servidor; ausente = só o texto do navegador. */
	transcribe?: ((audio: Blob, info: { language: string; durationMs: number }) => Promise<string>) | null;
	onInsert: (text: string) => void;
	/** Só para falha real (permissão negada, servidor falhou); não "não configurado". */
	onError?: (message: string) => void;
	onChange?: (view: DictationView) => void;
};

const POLL_MS = 100;
const TICK_MS = 250;

export function createDictationController(options: DictationOptions) {
	const { deps } = options;
	let phase: DictationPhase = "idle";
	let preview = "";
	let startedAt = 0;
	let elapsedMs = 0;
	let session = 0;
	let heardVoice = false;
	let stream: StreamLike | null = null;
	let recorder: MediaRecorderLike | null = null;
	let recognition: SpeechRecognitionLike | null = null;
	let meter: LevelMeter | null = null;
	let chunks: Blob[] = [];
	let cancelled = false;
	let maxTimer: unknown = null;
	let silenceTimer: unknown = null;
	let tickTimer: unknown = null;
	let pollTimer: unknown = null;

	const currentPhase = (): DictationPhase => phase;
	const emit = () => options.onChange?.({ phase, preview, elapsedMs });
	const move = (event: DictationEvent) => {
		phase = dictationTransition(phase, event);
	};

	function clearTimers() {
		for (const id of [maxTimer, silenceTimer]) if (id !== null) deps.clearTimeout(id);
		for (const id of [tickTimer, pollTimer]) if (id !== null) deps.clearInterval(id);
		maxTimer = silenceTimer = tickTimer = pollTimer = null;
	}

	function stopTracks() {
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
	}

	function releaseHardware() {
		clearTimers();
		meter?.close();
		meter = null;
		if (recognition) {
			recognition.onresult = recognition.onend = recognition.onerror = null;
			try {
				recognition.abort();
			} catch {
				// já parado
			}
			recognition = null;
		}
		stopTracks();
	}

	function armSilence(ms: number) {
		if (silenceTimer !== null) deps.clearTimeout(silenceTimer);
		silenceTimer = deps.setTimeout(() => stopWith("silence"), ms);
	}

	/** Voz detectada (fala reconhecida ou nível de áudio): rearma a contagem do silêncio. */
	function onVoiceActivity() {
		if (phase !== "recording") return;
		heardVoice = true;
		armSilence(SILENCE_STOP_MS);
	}

	function stopWith(event: "stop" | "timeout" | "silence") {
		if (phase !== "recording") return;
		const durationMs = deps.now() - startedAt;
		elapsedMs = durationMs;
		move(event);
		clearTimers();
		meter?.close();
		meter = null;
		if (recognition) {
			recognition.onend = null;
			try {
				recognition.stop();
			} catch {
				// já parado
			}
		}
		emit();
		if (recorder) {
			try {
				recorder.stop();
				return;
			} catch {
				// sem gravador utilizável: fecha direto
			}
		}
		void finalize(durationMs);
	}

	async function finalize(durationMs: number) {
		const mine = session;
		const browserText = preview.trim();
		const mime = recorder?.mimeType || chunks[0]?.type || "audio/webm";
		const audio = new Blob(chunks, { type: mime });
		stopTracks();
		if (recognition) {
			recognition.onresult = recognition.onerror = null;
			recognition = null;
		}
		let text = browserText;
		if (options.transcribe && audio.size > 0 && (heardVoice || browserText)) {
			try {
				const server = (await options.transcribe(audio, { language: speechLangFor(options.language), durationMs })).trim();
				if (server) text = server;
			} catch (error) {
				if (mine === session && !cancelled) {
					options.onError?.(error instanceof Error && error.message ? error.message : activeT("errors.dictationFallback"));
				}
			}
		}
		if (mine !== session || cancelled) return;
		move("done");
		preview = "";
		recorder = null;
		chunks = [];
		emit();
		if (text) options.onInsert(text);
	}

	async function start() {
		if (phase !== "idle" || !deps.getUserMedia || !deps.createRecorder) return;
		session += 1;
		const mine = session;
		cancelled = false;
		heardVoice = false;
		preview = "";
		chunks = [];
		elapsedMs = 0;
		move("start");
		emit();
		let media: StreamLike;
		try {
			media = await deps.getUserMedia();
		} catch {
			if (mine !== session) return;
			move("fail");
			emit();
			options.onError?.(activeT("errors.microphoneDenied"));
			return;
		}
		if (mine !== session || cancelled || currentPhase() !== "recording") {
			for (const track of media.getTracks()) track.stop();
			// Parou antes da permissão chegar: nada foi gravado.
			if (mine === session && !cancelled) {
				move("fail");
				emit();
			}
			return;
		}
		stream = media;
		startedAt = deps.now();
		const rec = deps.createRecorder(media);
		recorder = rec;
		rec.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		rec.onstop = () => {
			if (mine === session && !cancelled) void finalize(deps.now() - startedAt);
		};
		rec.start();

		if (deps.createRecognition) {
			const speech = deps.createRecognition();
			recognition = speech;
			speech.lang = speechLangFor(options.language);
			speech.continuous = true;
			speech.interimResults = true;
			speech.onresult = (event) => {
				let text = "";
				for (let i = 0; i < event.results.length; i++) text += event.results[i]![0].transcript;
				preview = text.trim();
				onVoiceActivity();
				emit();
			};
			// O navegador encerra sozinho após silêncio: trata como fim da fala.
			speech.onend = () => {
				if (phase === "recording") stopWith("silence");
			};
			speech.onerror = () => {
				// no-speech/aborted: o detector de silêncio decide; o gravador segue.
			};
			try {
				speech.start();
			} catch {
				recognition = null;
			}
		}
		if (deps.createLevelMeter) {
			try {
				const level = deps.createLevelMeter(media);
				meter = level;
				pollTimer = deps.setInterval(() => {
					if (level.read() > VOICE_LEVEL_THRESHOLD) onVoiceActivity();
				}, POLL_MS);
			} catch {
				meter = null;
			}
		}
		tickTimer = deps.setInterval(() => {
			elapsedMs = deps.now() - startedAt;
			emit();
		}, TICK_MS);
		maxTimer = deps.setTimeout(() => stopWith("timeout"), MAX_DICTATION_MS);
		armSilence(NO_SPEECH_STOP_MS);
		emit();
	}

	function stop() {
		stopWith("stop");
	}

	/** Esc: descarta tudo e não insere nada. */
	function cancel() {
		if (phase === "idle") return;
		cancelled = true;
		session += 1;
		if (recorder) {
			recorder.ondataavailable = recorder.onstop = null;
			try {
				recorder.stop();
			} catch {
				// já parado
			}
		}
		releaseHardware();
		recorder = null;
		chunks = [];
		preview = "";
		elapsedMs = 0;
		move("cancel");
		emit();
	}

	return { start, stop, cancel, getView: (): DictationView => ({ phase, preview, elapsedMs }) };
}

export type DictationController = ReturnType<typeof createDictationController>;
