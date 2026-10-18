"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTranscriptionStatus, transcribeDictation } from "@/lib/atlas-api";
import {
	createDictationController,
	type DictationController,
	type DictationDeps,
	type DictationView,
	type LevelMeter,
	type SpeechRecognitionLike,
	type StreamLike,
} from "@/lib/dictation-controller";
import { rmsLevel } from "@/lib/dictation";

export type DictationState = DictationView & {
	/** Navegador consegue gravar E há como transcrever (fala do navegador ou STT no servidor). */
	supported: boolean;
	start: () => void;
	stop: () => void;
	cancel: () => void;
};

type SpeechCtor = new () => SpeechRecognitionLike;

const IDLE_VIEW: DictationView = { phase: "idle", preview: "", elapsedMs: 0 };
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function speechCtor(): SpeechCtor | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Medidor de nível via Web Audio (AnalyserNode) para detectar silêncio mesmo sem Web Speech. */
function createLevelMeter(stream: StreamLike): LevelMeter {
	const AudioCtx = window.AudioContext;
	const context = new AudioCtx();
	const analyser = context.createAnalyser();
	analyser.fftSize = 512;
	context.createMediaStreamSource(stream as MediaStream).connect(analyser);
	const samples = new Uint8Array(analyser.fftSize);
	return {
		read() {
			analyser.getByteTimeDomainData(samples);
			return rmsLevel(samples);
		},
		close() {
			void context.close().catch(() => undefined);
		},
	};
}

/** APIs reais do navegador; nulas quando indisponíveis (SSR, Firefox sem fala, sem microfone). */
export function browserDictationDeps(): DictationDeps {
	const canRecord =
		typeof window !== "undefined" &&
		typeof MediaRecorder !== "undefined" &&
		typeof navigator !== "undefined" &&
		Boolean(navigator.mediaDevices?.getUserMedia);
	const Speech = speechCtor();
	return {
		createRecognition: Speech ? () => new Speech() : null,
		getUserMedia: canRecord ? () => navigator.mediaDevices.getUserMedia({ audio: true }) : null,
		createRecorder: canRecord
			? (stream) => {
					const type = RECORDER_TYPES.find((item) => MediaRecorder.isTypeSupported?.(item));
					return new MediaRecorder(stream as MediaStream, type ? { mimeType: type } : undefined) as unknown as ReturnType<NonNullable<DictationDeps["createRecorder"]>>;
				}
			: null,
		createLevelMeter: typeof window !== "undefined" && typeof window.AudioContext !== "undefined" ? createLevelMeter : null,
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
		setInterval: (fn, ms) => setInterval(fn, ms),
		clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
		now: () => Date.now(),
	};
}

let statusPromise: Promise<boolean> | null = null;
function serverSttAvailable(): Promise<boolean> {
	statusPromise ??= getTranscriptionStatus().then((s) => s.available).catch(() => false);
	return statusPromise;
}

/**
 * Ditado por voz: prévia ao vivo (Web Speech) + gravação (MediaRecorder) +
 * transcrição final no servidor quando configurada. A lógica mora em
 * `dictation-controller`; aqui só ligamos ao React e às APIs do navegador.
 */
export function useDictation({
	language,
	onInsert,
	onError,
	deps,
	serverStt,
}: {
	language?: string | null;
	onInsert: (text: string) => void;
	onError?: (message: string) => void;
	/** Injeção para testes; padrão = APIs do navegador. */
	deps?: DictationDeps;
	/** Injeção para testes; padrão = consulta GET /v1/transcriptions/status. */
	serverStt?: boolean;
}): DictationState {
	const [view, setView] = useState<DictationView>(IDLE_VIEW);
	const [resolvedDeps, setResolvedDeps] = useState<DictationDeps | null>(deps ?? null);
	const [serverAvailable, setServerAvailable] = useState(serverStt ?? false);
	const insertRef = useRef(onInsert);
	const errorRef = useRef(onError);
	const languageRef = useRef(language);
	insertRef.current = onInsert;
	errorRef.current = onError;
	languageRef.current = language;

	// Só no cliente: evita divergência de hidratação.
	useEffect(() => {
		if (!deps) setResolvedDeps(browserDictationDeps());
		if (serverStt === undefined) {
			let alive = true;
			void serverSttAvailable().then((ok) => alive && setServerAvailable(ok));
			return () => {
				alive = false;
			};
		}
	}, [deps, serverStt]);

	const controller = useMemo<DictationController | null>(() => {
		if (!resolvedDeps) return null;
		return createDictationController({
			deps: resolvedDeps,
			get language() {
				return languageRef.current;
			},
			transcribe: serverAvailable ? (audio, info) => transcribeDictation(audio, info) : null,
			onInsert: (text) => insertRef.current(text),
			onError: (message) => errorRef.current?.(message),
			onChange: setView,
		});
	}, [resolvedDeps, serverAvailable]);

	useEffect(() => () => controller?.cancel(), [controller]);

	const canRecord = Boolean(resolvedDeps?.getUserMedia && resolvedDeps.createRecorder);
	const supported = canRecord && (Boolean(resolvedDeps?.createRecognition) || serverAvailable);

	const start = useCallback(() => void controller?.start(), [controller]);
	const stop = useCallback(() => controller?.stop(), [controller]);
	const cancel = useCallback(() => controller?.cancel(), [controller]);

	return { ...view, supported, start, stop, cancel };
}
