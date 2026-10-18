// Ticker: UM loop de rAF para todos os avatares montados e UM listener de
// pointermove. Dorme quando todos assentam (as piscadas acordam por timer, não
// por quadros), pausa com a aba oculta e, por avatar, fora da tela.
//
// Duas bases de tempo, nunca misturadas: o `ts` do rAF mede os quadros
// (dt = ts − ts anterior do mesmo avatar) e `env.now()` mede só o tempo
// dormido entre dois pontos no mesmo domínio (começo e fim do sono). Misturar
// as duas dava dt negativo/pequeno demais e quadros pulados, que apareciam
// como tremor ("pisca-pisca") enquanto o mouse se mexia. O ambiente (rAF,
// relógio, DOM) é injetado: os testes usam um falso, e nada aqui toca em
// `window` na importação.
import type { AvatarEngine } from "../engine";
import type { Frame } from "../model/character";

export type FollowMode = "always" | "hover" | "off";

export type TickerEnv = {
	now(): number;
	raf(cb: (ts: number) => void): number;
	caf(id: number): void;
	setTimer(cb: () => void, ms: number): number;
	clearTimer(id: number): void;
	isHidden(): boolean;
	onVisibilityChange(cb: () => void): () => void;
	onPointerMove(cb: (x: number, y: number) => void): () => void;
	onPointerLeave(cb: () => void): () => void;
	observeVisible(element: Element, cb: (visible: boolean) => void): () => void;
};

export type AvatarEntryInput = {
	engine: AvatarEngine;
	/** Escreve o quadro no DOM (só o que mudou). */
	apply: (frame: Frame) => void;
	follow: FollowMode;
	/** Centro do avatar na tela, para o olhar. */
	getCenter: () => { x: number; y: number } | null;
	/** Elemento observado (IntersectionObserver). */
	element?: Element | null;
};

export type AvatarHandle = {
	/** Acorda o avatar, aplica a mudança e garante que o loop rode. */
	interact(change: (engine: AvatarEngine) => void): void;
	setHovered(hovered: boolean): void;
	unregister(): void;
};

type Gaze = { x: number; y: number } | null;

type Entry = AvatarEntryInput & {
	visible: boolean;
	hovered: boolean;
	/** `ts` do rAF do último quadro; `null` = recomeçar a medir. */
	lastTs: number | null;
	/** `env.now()` de quando assentou; `null` = não está dormindo. */
	sleptAt: number | null;
	/** Olhar a aplicar no próximo quadro (`undefined` = nada pendente). */
	pendingGaze: Gaze | undefined;
	stopObserving: (() => void) | null;
};

/** Raio (px) em que o olhar vai ao máximo. */
export const GAZE_RANGE_PX = 160;
/** Intervalo mínimo entre quadros processados (≈ 60 fps). */
export const MIN_FRAME_MS = 15;
/** Quadro longo demais (aba lenta) é tratado como no máximo isto. */
const MAX_DT_MS = 100;

/** Vetor de olhar (-1..1) do ponteiro em relação ao centro do avatar. */
export function gazeVector(
	pointer: { x: number; y: number },
	center: { x: number; y: number },
	range = GAZE_RANGE_PX,
): { x: number; y: number } {
	const x = (pointer.x - center.x) / range;
	const y = (pointer.y - center.y) / range;
	const len = Math.hypot(x, y);
	return len > 1 ? { x: x / len, y: y / len } : { x, y };
}

export type AvatarTicker = ReturnType<typeof createTicker>;

export function createTicker(env: TickerEnv) {
	const entries = new Set<Entry>();
	let rafId: number | null = null;
	let timerId: number | null = null;
	let pointer: { x: number; y: number } | null = null;
	let lastTick = Number.NEGATIVE_INFINITY;
	let detach: (() => void)[] = [];

	const follows = (entry: Entry) =>
		entry.follow === "always" || (entry.follow === "hover" && entry.hovered);

	const awake = (entry: Entry) =>
		entry.visible && (!entry.engine.isSettled() || entry.pendingGaze !== undefined);

	const anyAwake = () => {
		for (const entry of entries) if (awake(entry)) return true;
		return false;
	};

	function clearTimerIfAny() {
		if (timerId !== null) env.clearTimer(timerId);
		timerId = null;
	}

	/** Passa o tempo dormido (domínio de `env.now`) ao comportamento do avatar. */
	function settleSleep(entry: Entry, now: number) {
		if (entry.sleptAt === null) return;
		const slept = now - entry.sleptAt;
		entry.sleptAt = null;
		if (slept > 0) entry.apply(entry.engine.skip(slept));
	}

	/** Acorda um avatar assentado: conta o sono e recomeça o relógio do rAF. */
	function wake(entry: Entry) {
		settleSleep(entry, env.now());
		if (entry.engine.isSettled()) entry.lastTs = null;
	}

	function scheduleSleep() {
		clearTimerIfAny();
		if (env.isHidden()) return;
		const now = env.now();
		let soonest = Number.POSITIVE_INFINITY;
		for (const entry of entries) {
			if (!entry.visible || !entry.engine.isSettled()) continue;
			entry.sleptAt ??= now;
			soonest = Math.min(soonest, entry.engine.nextWakeMs() - (now - entry.sleptAt));
		}
		if (!Number.isFinite(soonest)) return;
		timerId = env.setTimer(onTimer, Math.max(1, soonest));
	}

	/**
	 * Avatar assentado enquanto OUTRO avatar mantém o loop de rAF vivo (ex.: o
	 * que está "trabalhando"). Nesse caso `scheduleSleep` não roda e o timer de
	 * piscada é cancelado, então ninguém contava o tempo dele: ele congelava
	 * (sem piscar, sem olhar) até todo o resto assentar. Aqui o relógio do sono
	 * continua andando e a piscada vencida acorda o avatar.
	 */
	function keepSleepClock(entry: Entry) {
		const now = env.now();
		if (entry.sleptAt === null) {
			entry.sleptAt = now;
			return;
		}
		if (now - entry.sleptAt < entry.engine.nextWakeMs()) return;
		settleSleep(entry, now);
		if (entry.engine.isSettled()) entry.sleptAt = now;
		else entry.lastTs = null;
	}

	function onTimer() {
		timerId = null;
		const now = env.now();
		for (const entry of entries) {
			if (!entry.visible || entry.sleptAt === null) continue;
			settleSleep(entry, now);
			// Se ainda assentado, recomeça a contar o sono daqui.
			if (entry.engine.isSettled()) entry.sleptAt = now;
			else entry.lastTs = null;
		}
		ensureRunning();
	}

	function ensureRunning() {
		if (env.isHidden()) return;
		if (anyAwake()) {
			clearTimerIfAny();
			if (rafId === null) rafId = env.raf(tick);
		} else if (rafId === null) {
			scheduleSleep();
		}
	}

	function tick(ts: number) {
		rafId = null;
		if (env.isHidden()) return;
		if (ts - lastTick >= MIN_FRAME_MS) {
			lastTick = ts;
			// Leituras de layout primeiro, escritas no DOM depois (sem thrash).
			for (const entry of entries) {
				if (entry.visible && entry.pendingGaze !== undefined && entry.pendingGaze !== null) {
					const center = entry.getCenter();
					if (center && pointer) entry.pendingGaze = gazeVector(pointer, center);
				}
			}
			for (const entry of entries) {
				if (!entry.visible) continue;
				if (entry.lastTs === null) {
					// Primeiro quadro depois de acordar: só ancora o relógio do rAF.
					entry.lastTs = ts;
				}
				if (entry.pendingGaze !== undefined) {
					entry.engine.setGaze(entry.pendingGaze, entry.follow === "always");
					entry.pendingGaze = undefined;
				}
				if (entry.engine.isSettled()) {
					entry.lastTs = null;
					keepSleepClock(entry);
					continue;
				}
				const dt = Math.min(ts - entry.lastTs, MAX_DT_MS);
				if (dt < entry.engine.frameIntervalMs() - 2) continue;
				entry.lastTs = ts;
				entry.apply(entry.engine.advance(dt));
			}
		}
		if (anyAwake()) rafId = env.raf(tick);
		else scheduleSleep();
	}

	function aimAtPointer(entry: Entry) {
		if (!entry.visible || !follows(entry)) return;
		if (pointer) {
			const center = entry.getCenter();
			if (center) entry.pendingGaze = gazeVector(pointer, center);
		} else {
			entry.pendingGaze = null;
		}
	}

	function onPointer(x: number, y: number) {
		pointer = { x, y };
		for (const entry of entries) {
			if (entry.visible && follows(entry)) {
				wake(entry);
				// O vetor exato é calculado no tick (uma leitura de layout por quadro).
				entry.pendingGaze ??= { x: 0, y: 0 };
			}
		}
		ensureRunning();
	}

	function onLeave() {
		pointer = null;
		for (const entry of entries) {
			if (entry.follow === "always" && entry.visible) {
				wake(entry);
				entry.pendingGaze = null;
			}
		}
		ensureRunning();
	}

	function onVisibility() {
		if (env.isHidden()) {
			if (rafId !== null) env.caf(rafId);
			rafId = null;
			clearTimerIfAny();
			return;
		}
		// O tempo escondido não conta: recomeça a medir tudo.
		for (const entry of entries) {
			entry.lastTs = null;
			entry.sleptAt = null;
		}
		ensureRunning();
	}

	function attach() {
		if (detach.length) return;
		detach = [
			env.onPointerMove(onPointer),
			env.onPointerLeave(onLeave),
			env.onVisibilityChange(onVisibility),
		];
	}

	function release() {
		for (const off of detach) off();
		detach = [];
		if (rafId !== null) env.caf(rafId);
		rafId = null;
		clearTimerIfAny();
	}

	return {
		register(input: AvatarEntryInput): AvatarHandle {
			const entry: Entry = {
				...input,
				visible: true,
				hovered: false,
				lastTs: null,
				sleptAt: null,
				pendingGaze: undefined,
				stopObserving: null,
			};
			entries.add(entry);
			attach();
			if (input.element) {
				entry.stopObserving = env.observeVisible(input.element, (visible) => {
					if (visible === entry.visible) return;
					entry.visible = visible;
					entry.lastTs = null;
					entry.sleptAt = null;
					ensureRunning();
				});
			}
			// Aplica o repouso e agenda a primeira piscada.
			entry.apply(entry.engine.snapshot());
			ensureRunning();
			return {
				interact(change) {
					wake(entry);
					change(entry.engine);
					ensureRunning();
				},
				setHovered(hovered) {
					entry.hovered = hovered;
					if (entry.follow === "hover") {
						wake(entry);
						if (hovered) aimAtPointer(entry);
						else entry.pendingGaze = null;
						ensureRunning();
					}
				},
				unregister() {
					entry.stopObserving?.();
					entries.delete(entry);
					if (entries.size === 0) release();
					else ensureRunning();
				},
			};
		},
		/** Diagnóstico e testes. */
		stats() {
			return {
				entries: entries.size,
				looping: rafId !== null,
				sleepTimer: timerId !== null,
			};
		},
	};
}

export function createBrowserEnv(): TickerEnv {
	return {
		now: () => performance.now(),
		raf: (cb) => requestAnimationFrame(cb),
		caf: (id) => cancelAnimationFrame(id),
		setTimer: (cb, ms) => window.setTimeout(cb, ms),
		clearTimer: (id) => window.clearTimeout(id),
		isHidden: () => document.hidden,
		onVisibilityChange(cb) {
			document.addEventListener("visibilitychange", cb);
			return () => document.removeEventListener("visibilitychange", cb);
		},
		onPointerMove(cb) {
			const handler = (event: PointerEvent) => cb(event.clientX, event.clientY);
			window.addEventListener("pointermove", handler, { passive: true });
			return () => window.removeEventListener("pointermove", handler);
		},
		onPointerLeave(cb) {
			document.documentElement.addEventListener("pointerleave", cb);
			return () => document.documentElement.removeEventListener("pointerleave", cb);
		},
		observeVisible(element, cb) {
			if (typeof IntersectionObserver === "undefined") return () => {};
			// Margem de 64 px: evita oscilar visível/invisível na borda da tela.
			const observer = new IntersectionObserver(
				(records) => {
					const last = records[records.length - 1];
					if (last) cb(last.isIntersecting);
				},
				{ rootMargin: "64px" },
			);
			observer.observe(element);
			return () => observer.disconnect();
		},
	};
}

let shared: AvatarTicker | null = null;

/** Ticker do navegador, compartilhado. Chame só em efeitos (cliente). */
export function getTicker(): AvatarTicker {
	shared ??= createTicker(createBrowserEnv());
	return shared;
}
