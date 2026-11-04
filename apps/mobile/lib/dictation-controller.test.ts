import { describe, expect, it } from "vitest";
import { FINALIZE_WAIT_MS, NO_SPEECH_STOP_MS, SILENCE_STOP_MS, type DictationOutcome, type DictationProblem } from "./dictation";
import { createDictationController, type DictationView, type SpeechEngine } from "./dictation-controller";

function setup(overrides: Partial<{ available: boolean; granted: boolean; onDevice: boolean }> = {}) {
	const { available = true, granted = true, onDevice = true } = overrides;
	const handlers: Record<string, Array<(arg: unknown) => void>> = {};
	const calls: string[] = [];
	const startOptions: Array<{ lang: string; onDevice: boolean }> = [];
	const reg = <T>(name: string) => (listener: (arg: T) => void) => {
		const wrapped = (arg: unknown) => listener(arg as T);
		(handlers[name] ??= []).push(wrapped);
		return () => {
			handlers[name] = (handlers[name] ?? []).filter((item) => item !== wrapped);
		};
	};
	const engine: SpeechEngine = {
		available: () => available,
		supportsOnDevice: () => onDevice,
		requestPermissions: async () => ({ granted }),
		start: (options) => {
			calls.push("start");
			startOptions.push(options);
		},
		stop: () => calls.push("stop") && undefined,
		abort: () => calls.push("abort") && undefined,
		onResult: reg<{ transcript: string; isFinal: boolean }>("result"),
		onSpeechStart: reg<void>("speechstart"),
		onVolume: reg<number>("volume"),
		onEnd: reg<void>("end"),
		onError: reg<string>("error"),
	};
	let now = 0;
	const timeouts = new Map<number, { at: number; fn: () => void }>();
	let nextId = 1;
	const timers = {
		setTimeout: (fn: () => void, ms: number) => {
			const id = nextId++;
			timeouts.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout: (id: unknown) => void timeouts.delete(id as number),
	};
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			const due = [...timeouts.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			timeouts.delete(due[0]);
			now = due[1].at;
			due[1].fn();
		}
		now = target;
	};
	const views: DictationView[] = [];
	const finished: Array<{ outcome: DictationOutcome; spoken: string }> = [];
	const problems: DictationProblem[] = [];
	const controller = createDictationController({
		engine,
		timers,
		language: "pt-BR",
		onChange: (view) => views.push(view),
		onFinish: (result) => finished.push(result),
		onProblem: (problem) => problems.push(problem),
	});
	const emit = (name: string, arg?: unknown) => {
		for (const listener of [...(handlers[name] ?? [])]) listener(arg);
	};
	return { controller, emit, advance, calls, startOptions, views, finished, problems, last: () => views[views.length - 1] };
}

const say = (h: ReturnType<typeof setup>, transcript: string, isFinal = false) => h.emit("result", { transcript, isFinal });

describe("dictation controller", () => {
	it("sem módulo nativo (Expo Go) só avisa e não quebra", async () => {
		const problems: DictationProblem[] = [];
		const controller = createDictationController({ engine: null, timers: { setTimeout: () => 0, clearTimeout: () => undefined }, language: "pt-BR", onChange: () => undefined, onFinish: () => undefined, onProblem: (p) => problems.push(p) });
		await controller.start();
		expect(problems).toEqual(["missing-module"]);
		expect(controller.getView().phase).toBe("idle");
	});

	it("sem serviço de voz no aparelho avisa", async () => {
		const h = setup({ available: false });
		await h.controller.start();
		expect(h.problems).toEqual(["unavailable"]);
		expect(h.calls).toEqual([]);
	});

	it("permissão negada avisa e não começa a ouvir", async () => {
		const h = setup({ granted: false });
		await h.controller.start();
		expect(h.problems).toEqual(["permission"]);
		expect(h.calls).toEqual([]);
		expect(h.last()?.phase).toBe("idle");
	});

	it("começa com idioma e on-device do aparelho e mostra o parcial ao vivo", async () => {
		const h = setup();
		await h.controller.start();
		expect(h.startOptions).toEqual([{ lang: "pt-BR", onDevice: true }]);
		say(h, "olá");
		say(h, "olá mundo");
		expect(h.last()).toMatchObject({ phase: "listening", spoken: "olá mundo" });
	});

	it("parar e revisar espera o final e entrega como review", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "olá mundo");
		h.controller.stop("review");
		expect(h.last()?.phase).toBe("stopping");
		say(h, "olá mundo!", true);
		h.emit("end");
		expect(h.finished).toEqual([{ outcome: "review", spoken: "olá mundo!" }]);
		expect(h.last()?.phase).toBe("idle");
	});

	it("parar e enviar entrega como send", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "manda isso");
		h.controller.stop("send");
		h.emit("end");
		expect(h.finished).toEqual([{ outcome: "send", spoken: "manda isso" }]);
	});

	it("se o final não vier, fecha com o que já chegou", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "quase");
		h.controller.stop("review");
		h.advance(FINALIZE_WAIT_MS + 1);
		expect(h.finished).toEqual([{ outcome: "review", spoken: "quase" }]);
	});

	it("cancelar aborta e não entrega texto", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "descarta");
		h.controller.cancel();
		expect(h.calls).toContain("abort");
		expect(h.finished).toEqual([{ outcome: "cancel", spoken: "" }]);
		expect(h.last()).toMatchObject({ phase: "idle", spoken: "" });
		// resultados tardios não ressuscitam o ditado
		say(h, "atrasado");
		expect(h.last()?.spoken).toBe("");
	});

	it("silêncio depois da fala encerra como review", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "terminei");
		h.advance(SILENCE_STOP_MS + 1);
		expect(h.last()?.phase).toBe("stopping");
		h.emit("end");
		expect(h.finished).toEqual([{ outcome: "review", spoken: "terminei" }]);
	});

	it("fim espontâneo do sistema também vai para revisão", async () => {
		const h = setup();
		await h.controller.start();
		say(h, "acabou", true);
		h.emit("end");
		expect(h.finished).toEqual([{ outcome: "review", spoken: "acabou" }]);
	});

	it("ninguém fala: desiste em 6 s sem inserir nada", async () => {
		const h = setup();
		await h.controller.start();
		h.advance(NO_SPEECH_STOP_MS + 1);
		h.emit("end");
		expect(h.finished).toEqual([{ outcome: "review", spoken: "" }]);
	});

	it("modelo do aparelho ausente para o idioma: tenta uma vez com o serviço do sistema", async () => {
		const h = setup();
		await h.controller.start();
		h.emit("error", "language-not-supported");
		expect(h.startOptions).toEqual([
			{ lang: "pt-BR", onDevice: true },
			{ lang: "pt-BR", onDevice: false },
		]);
		expect(h.last()?.phase).toBe("listening");
	});

	it("erro sem fala volta a idle e avisa; erro depois de falar guarda o texto", async () => {
		const a = setup();
		await a.controller.start();
		a.emit("error", "network");
		expect(a.problems).toEqual(["failed"]);
		expect(a.last()?.phase).toBe("idle");

		const b = setup();
		await b.controller.start();
		say(b, "não perde");
		b.emit("error", "network");
		expect(b.finished).toEqual([{ outcome: "review", spoken: "não perde" }]);
	});

	it("sem fala (no-speech) termina em silêncio, sem aviso", async () => {
		const h = setup();
		await h.controller.start();
		h.emit("error", "no-speech");
		expect(h.problems).toEqual([]);
		expect(h.last()?.phase).toBe("idle");
	});

	it("repassa o volume para a barra", async () => {
		const h = setup();
		await h.controller.start();
		h.emit("volume", 7);
		expect(h.last()?.level).toBe(7);
	});
});
