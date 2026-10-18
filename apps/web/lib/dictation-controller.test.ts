import assert from "node:assert/strict";
import test from "node:test";
import {
	createDictationController,
	type DictationDeps,
	type DictationView,
	type MediaRecorderLike,
	type SpeechRecognitionLike,
} from "./dictation-controller";
import { MAX_DICTATION_MS, NO_SPEECH_STOP_MS, SILENCE_STOP_MS } from "./dictation";

/** Relógio falso: timers só andam quando o teste manda. */
function fakeClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
	return {
		now: () => now,
		setTimeout: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn }); return seq; },
		clearTimeout: (id: unknown) => { timers.delete(id as number); },
		setInterval: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn, every: ms }); return seq; },
		clearInterval: (id: unknown) => { timers.delete(id as number); },
		advance(ms: number) {
			const end = now + ms;
			while (true) {
				const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				const [id, t] = next;
				now = t.at;
				if (t.every) t.at += t.every; else timers.delete(id);
				t.fn();
			}
			now = end;
		},
	};
}

type Harness = ReturnType<typeof setup>;

function setup(opts: {
	speech?: boolean;
	transcribe?: ((blob: Blob) => Promise<string>) | null;
	denyMic?: boolean;
	level?: { value: number };
} = {}) {
	const clock = fakeClock();
	const inserted: string[] = [];
	const errors: string[] = [];
	const views: DictationView[] = [];
	let recognition: (SpeechRecognitionLike & { stopped: boolean }) | null = null;
	let recorder: (MediaRecorderLike & { stopped: boolean }) | null = null;
	let tracksStopped = 0;
	const deps: DictationDeps = {
		...clock,
		createRecognition: opts.speech === false ? null : () => {
			const r = { lang: "", continuous: false, interimResults: false, onresult: null, onend: null, onerror: null, stopped: false, start() {}, stop() { r.stopped = true; }, abort() { r.stopped = true; } } as SpeechRecognitionLike & { stopped: boolean };
			recognition = r;
			return r;
		},
		getUserMedia: async () => {
			if (opts.denyMic) throw new Error("denied");
			return { getTracks: () => [{ stop: () => { tracksStopped++; } }] };
		},
		createRecorder: () => {
			const r = {
				mimeType: "audio/webm", ondataavailable: null, onstop: null, stopped: false,
				start() { setTimeout(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(10)]) }), 0); },
				stop() { r.stopped = true; queueMicrotask(() => r.onstop?.()); },
			} as MediaRecorderLike & { stopped: boolean };
			recorder = r;
			return r;
		},
		createLevelMeter: opts.level ? () => ({ read: () => opts.level!.value, close() {} }) : null,
	};
	const controller = createDictationController({
		deps,
		language: "en-US",
		transcribe: opts.transcribe === undefined ? null : opts.transcribe,
		onInsert: (t) => inserted.push(t),
		onError: (m) => errors.push(m),
		onChange: (v) => views.push(v),
	});
	const say = (text: string) => recognition!.onresult!({ results: [{ isFinal: false, 0: { transcript: text } }] });
	const flush = async () => { await new Promise((r) => setTimeout(r, 5)); };
	return { clock, controller, inserted, errors, views, say, flush, get recognition() { return recognition!; }, get recorder() { return recorder!; }, get tracksStopped() { return tracksStopped; } };
}

async function begin(h: Harness) {
	await h.controller.start();
	await h.flush();
}

test("resultados parciais viram prévia e NÃO inserem nada no valor", async () => {
	const h = setup();
	await begin(h);
	h.say("olá mun");
	assert.equal(h.controller.getView().phase, "recording");
	assert.equal(h.controller.getView().preview, "olá mun");
	assert.equal(h.recognition.lang, "en-US");
	assert.deepEqual(h.inserted, []);
});

test("parar com servidor: insere o texto do servidor e limpa a prévia", async () => {
	const h = setup({ transcribe: async () => "texto preciso" });
	await begin(h);
	h.say("texto prec");
	h.controller.stop();
	assert.equal(h.controller.getView().phase, "transcribing");
	assert.equal(h.controller.getView().preview, "texto prec");
	await h.flush();
	assert.deepEqual(h.inserted, ["texto preciso"]);
	assert.equal(h.controller.getView().phase, "idle");
	assert.equal(h.controller.getView().preview, "");
	assert.equal(h.tracksStopped, 1);
});

test("falha do servidor: insere a prévia do navegador e avisa", async () => {
	const h = setup({ transcribe: async () => { throw new Error("Não consegui transcrever o áudio agora."); } });
	await begin(h);
	h.say("fallback do navegador");
	h.controller.stop();
	await h.flush();
	assert.deepEqual(h.inserted, ["fallback do navegador"]);
	assert.equal(h.errors.length, 1);
});

test("sem servidor configurado: insere a prévia e não mostra erro", async () => {
	const h = setup({ transcribe: null });
	await begin(h);
	h.say("só navegador");
	h.controller.stop();
	await h.flush();
	assert.deepEqual(h.inserted, ["só navegador"]);
	assert.deepEqual(h.errors, []);
});

test("sem SpeechRecognition (Firefox): grava e insere o resultado do servidor", async () => {
	const h = setup({ speech: false, level: { value: 0.3 }, transcribe: async () => "do servidor" });
	await begin(h);
	assert.equal(h.controller.getView().preview, "");
	h.clock.advance(200);
	h.controller.stop();
	await h.flush();
	assert.deepEqual(h.inserted, ["do servidor"]);
});

test("Esc cancela: nada é inserido, microfone liberado, servidor não é chamado", async () => {
	let called = false;
	const h = setup({ transcribe: async () => { called = true; return "x"; } });
	await begin(h);
	h.say("vai descartar");
	h.controller.cancel();
	await h.flush();
	assert.equal(h.controller.getView().phase, "idle");
	assert.deepEqual(h.inserted, []);
	assert.equal(called, false);
	assert.equal(h.tracksStopped, 1);
});

test("cancelar durante a transcrição descarta o resultado", async () => {
	let release: (t: string) => void = () => {};
	const h = setup({ transcribe: () => new Promise<string>((r) => { release = r; }) });
	await begin(h);
	h.say("algo");
	h.controller.stop();
	h.controller.cancel();
	release("tarde demais");
	await h.flush();
	assert.deepEqual(h.inserted, []);
	assert.equal(h.controller.getView().phase, "idle");
});

test("silêncio de 2 s depois da fala encerra sozinho", async () => {
	const h = setup({ transcribe: null });
	await begin(h);
	h.say("falei isso");
	h.clock.advance(SILENCE_STOP_MS - 100);
	assert.equal(h.controller.getView().phase, "recording");
	h.clock.advance(150);
	assert.equal(h.controller.getView().phase, "transcribing");
	await h.flush();
	assert.deepEqual(h.inserted, ["falei isso"]);
});

test("nova fala rearma o silêncio", async () => {
	const h = setup({ transcribe: null });
	await begin(h);
	h.say("um");
	h.clock.advance(1500);
	h.say("um dois");
	h.clock.advance(1500);
	assert.equal(h.controller.getView().phase, "recording");
	h.clock.advance(600);
	assert.equal(h.controller.getView().phase, "transcribing");
});

test("detector de nível do áudio também encerra no silêncio (sem Web Speech)", async () => {
	const level = { value: 0.3 };
	const h = setup({ speech: false, level, transcribe: async () => "ok" });
	await begin(h);
	h.clock.advance(500);
	level.value = 0;
	h.clock.advance(SILENCE_STOP_MS - 200);
	assert.equal(h.controller.getView().phase, "recording");
	h.clock.advance(400);
	assert.equal(h.controller.getView().phase, "transcribing");
	await h.flush();
	assert.deepEqual(h.inserted, ["ok"]);
});

test("ninguém fala: desiste após o prazo e não insere nada", async () => {
	const h = setup({ transcribe: async () => "não deveria" });
	await begin(h);
	h.clock.advance(NO_SPEECH_STOP_MS + 50);
	await h.flush();
	assert.deepEqual(h.inserted, []);
	assert.equal(h.controller.getView().phase, "idle");
});

test("limite de 2 minutos para a gravação", async () => {
	const level = { value: 0.3 };
	const h = setup({ speech: false, level, transcribe: async () => "longo" });
	await begin(h);
	h.clock.advance(MAX_DICTATION_MS - 100);
	assert.equal(h.controller.getView().phase, "recording");
	h.clock.advance(200);
	assert.equal(h.controller.getView().phase, "transcribing");
	await h.flush();
	assert.deepEqual(h.inserted, ["longo"]);
});

test("a gravação só acaba com a voz parada: o tempo decorrido avança", async () => {
	const level = { value: 0.3 };
	const h = setup({ speech: false, level });
	await begin(h);
	h.clock.advance(1000);
	assert.ok(h.controller.getView().elapsedMs >= 750);
});

test("permissão do microfone negada: volta a idle com erro e sem inserir", async () => {
	const h = setup({ denyMic: true });
	await h.controller.start();
	assert.equal(h.controller.getView().phase, "idle");
	assert.equal(h.errors.length, 1);
	assert.deepEqual(h.inserted, []);
});

test("parar antes da permissão chegar não deixa o microfone aberto", async () => {
	const h = setup();
	const pending = h.controller.start();
	h.controller.stop();
	await pending;
	assert.equal(h.controller.getView().phase, "idle");
	assert.equal(h.tracksStopped, 1);
});
