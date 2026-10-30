import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine";
import { SHAPE_IDS } from "../geometry/shapes";
import type { Frame } from "../model/character";
import { gazeVector, createTicker, type FollowMode, type TickerEnv } from "./ticker";

const FRAME_MS = 1000 / 60;

/**
 * Ambiente falso: rAF e timers manuais. `drift` faz `now()` andar à frente do
 * `ts` do rAF, como o performance.now() real em relação ao timestamp do quadro.
 */
function fakeEnv(drift = 0) {
	let ts = 1000;
	let nextId = 1;
	let hidden = false;
	const rafs = new Map<number, (ts: number) => void>();
	const timers = new Map<number, { at: number; cb: () => void }>();
	const pointerCbs: ((x: number, y: number) => void)[] = [];
	const leaveCbs: (() => void)[] = [];
	const visibilityCbs: (() => void)[] = [];
	const observers = new Map<Element, (visible: boolean) => void>();
	let pointerListeners = 0;
	let rafRequests = 0;

	const env: TickerEnv = {
		now: () => ts + drift,
		raf(cb) {
			const id = nextId++;
			rafRequests++;
			rafs.set(id, cb);
			return id;
		},
		caf: (id) => void rafs.delete(id),
		setTimer(cb, ms) {
			const id = nextId++;
			timers.set(id, { at: ts + drift + ms, cb });
			return id;
		},
		clearTimer: (id) => void timers.delete(id),
		isHidden: () => hidden,
		onVisibilityChange(cb) {
			visibilityCbs.push(cb);
			return () => void visibilityCbs.splice(visibilityCbs.indexOf(cb), 1);
		},
		onPointerMove(cb) {
			pointerListeners++;
			pointerCbs.push(cb);
			return () => {
				pointerListeners--;
				pointerCbs.splice(pointerCbs.indexOf(cb), 1);
			};
		},
		onPointerLeave(cb) {
			leaveCbs.push(cb);
			return () => void leaveCbs.splice(leaveCbs.indexOf(cb), 1);
		},
		observeVisible(element, cb) {
			observers.set(element, cb);
			return () => void observers.delete(element);
		},
	};

	function fireTimers() {
		for (const [id, timer] of [...timers]) {
			if (timer.at <= ts + drift) {
				timers.delete(id);
				timer.cb();
			}
		}
	}

	return {
		env,
		get pendingRafs() {
			return rafs.size;
		},
		get pendingTimers() {
			return timers.size;
		},
		get pointerListeners() {
			return pointerListeners;
		},
		get rafRequests() {
			return rafRequests;
		},
		/** Passa o tempo (timers vencidos disparam; nenhum quadro). */
		elapse(ms: number) {
			ts += ms;
			fireTimers();
		},
		/** Um quadro do navegador: timers vencidos e depois os rAFs. */
		frame(ms = FRAME_MS) {
			ts += ms;
			fireTimers();
			const due = [...rafs];
			rafs.clear();
			for (const [, cb] of due) cb(ts);
		},
		frames(count: number, ms = FRAME_MS) {
			for (let i = 0; i < count; i++) this.frame(ms);
		},
		movePointer(x: number, y: number) {
			for (const cb of [...pointerCbs]) cb(x, y);
		},
		leavePointer() {
			for (const cb of [...leaveCbs]) cb();
		},
		setHidden(value: boolean) {
			hidden = value;
			for (const cb of [...visibilityCbs]) cb();
		},
		setVisible(element: Element, visible: boolean) {
			observers.get(element)?.(visible);
		},
	};
}

function setup(
	opts: { seed?: string; follow?: FollowMode; drift?: number; breathe?: boolean; element?: Element } = {},
) {
	const fake = fakeEnv(opts.drift ?? 0);
	const ticker = createTicker(fake.env);
	const engine = createAvatarEngine({
		shape: "hex",
		seed: opts.seed ?? "bot",
		breathe: opts.breathe ?? false,
	});
	const applied: Frame[] = [];
	const advances: number[] = [];
	const original = engine.advance;
	engine.advance = (dt: number) => {
		advances.push(dt);
		return original(dt);
	};
	const handle = ticker.register({
		engine,
		apply: (frame) => applied.push(frame),
		follow: opts.follow ?? "off",
		getCenter: () => ({ x: 100, y: 100 }),
		element: opts.element,
	});
	return { fake, ticker, engine, handle, applied, advances };
}

describe("gazeVector", () => {
	it("escala pelo alcance e limita ao círculo unitário", () => {
		expect(gazeVector({ x: 180, y: 100 }, { x: 100, y: 100 }, 160)).toEqual({ x: 0.5, y: 0 });
		const far = gazeVector({ x: 1000, y: 1000 }, { x: 0, y: 0 }, 160);
		expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 6);
		expect(far.x).toBeCloseTo(far.y, 6);
	});
});

describe("ticker: dorme quando assentado", () => {
	it("sem nada acontecendo não há rAF, só um timer até a próxima piscada", () => {
		const { fake, ticker } = setup();
		expect(ticker.stats()).toEqual({ entries: 1, looping: false, sleepTimer: true });
		expect(fake.pendingRafs).toBe(0);
		expect(fake.rafRequests).toBe(0);
	});

	it("o timer acorda para piscar, o loop roda poucos quadros e volta a dormir", () => {
		const { fake, ticker, engine, applied } = setup({ seed: "dorminhoco" });
		const wake = engine.nextWakeMs();
		expect(wake).toBeGreaterThan(1900);
		expect(wake).toBeLessThan(6100);

		fake.elapse(wake + 1);
		expect(ticker.stats().looping).toBe(true);
		expect(ticker.stats().sleepTimer).toBe(false);

		let frames = 0;
		while (ticker.stats().looping && frames < 100) {
			fake.frame();
			frames++;
		}
		expect(ticker.stats().looping).toBe(false);
		expect(ticker.stats().sleepTimer).toBe(true);
		// piscada de 120 ms ≈ 8 quadros + assentar: bem menos que 1 s de loop.
		expect(frames).toBeGreaterThan(3);
		expect(frames).toBeLessThan(40);
		expect(applied.length).toBeGreaterThan(2);
	});

	it("depois de assentar não escreve mais nada no DOM por vários segundos", () => {
		const { fake, ticker, applied, engine } = setup({ seed: "quieto" });
		engine.poke();
		fake.frames(600);
		expect(ticker.stats().looping).toBe(false);
		const settledCount = applied.length;
		fake.elapse(1000);
		expect(applied.length).toBe(settledCount);
		expect(fake.pendingRafs).toBe(0);
	});
});

describe("orçamento: muitos avatares 3D assentados", () => {
	it("40 avatares de formas diferentes, com olhar 3D e clipes disponíveis, assentados = 0 rAF até a primeira piscada", () => {
		const fake = fakeEnv();
		const ticker = createTicker(fake.env);
		const shapes = SHAPE_IDS;
		const handles = Array.from({ length: 40 }, (_, i) => {
			const engine = createAvatarEngine({ shape: shapes[i % shapes.length] as string, seed: `bot-${i}`, breathe: false });
			return ticker.register({
				engine,
				apply: () => undefined,
				follow: "hover",
				getCenter: () => ({ x: 100, y: 100 }),
			});
		});
		expect(ticker.stats()).toEqual({ entries: 40, looping: false, sleepTimer: true });
		expect(fake.pendingRafs).toBe(0);
		expect(fake.rafRequests).toBe(0);
		// Antes da primeira piscada (mínimo 2 s) ninguém acorda: 1,9 s parados, zero quadros.
		fake.elapse(1900);
		expect(fake.pendingRafs).toBe(0);
		expect(fake.rafRequests).toBe(0);
		expect(ticker.stats().looping).toBe(false);
		for (const handle of handles) handle.unregister();
	});

	it("com um avatar vivo (clipes) o loop roda, mas os 39 assentados não pedem quadros próprios", () => {
		const fake = fakeEnv();
		const ticker = createTicker(fake.env);
		const applied = new Map<number, number>();
		for (let i = 0; i < 40; i++) {
			const engine = createAvatarEngine({ shape: SHAPE_IDS[i % SHAPE_IDS.length] as string, seed: `bot-${i}`, breathe: i === 0 });
			ticker.register({
				engine,
				apply: () => applied.set(i, (applied.get(i) ?? 0) + 1),
				follow: "off",
				getCenter: () => ({ x: 100, y: 100 }),
			});
		}
		expect(ticker.stats().looping).toBe(true);
		fake.frames(120);
		// o vivo escreve a cada quadro; cada assentado escreve só no piscar
		expect(applied.get(0) ?? 0).toBeGreaterThan(50);
		for (let i = 1; i < 40; i++) expect(applied.get(i) ?? 0, `avatar ${i}`).toBeLessThan(20);
	});
});

describe("REGRESSÃO: avatar assentado congelava com outro avatar animando", () => {
	// Causa raiz: com um avatar "trabalhando" (ou respirando) o rAF nunca para;
	// `ensureRunning` cancelava o timer de piscada e o tick pulava os assentados
	// sem contar o tempo deles. Resultado: todos os outros avatares (cabeçalho
	// do chat, sidebar) ficavam parados enquanto aquele rodasse.
	it("pisca mesmo com outro avatar mantendo o loop vivo", () => {
		const fake = fakeEnv();
		const ticker = createTicker(fake.env);
		const mk = (seed: string, breathe: boolean) => {
			const engine = createAvatarEngine({ shape: "hex", seed, breathe });
			const applied: Frame[] = [];
			const handle = ticker.register({
				engine,
				apply: (f) => applied.push(f),
				follow: "off",
				getCenter: () => ({ x: 0, y: 0 }),
			});
			return { engine, applied, handle };
		};
		const quiet = mk("quieto", false);
		const busy = mk("ocupado", true);
		expect(busy.engine.isSettled()).toBe(false);
		const before = quiet.applied.length;
		// 12 s de quadros: pelo menos uma piscada (2..6 s) tem de ser escrita.
		fake.frames(60 * 12);
		expect(ticker.stats().looping).toBe(true);
		expect(quiet.applied.length - before).toBeGreaterThan(3);
	});

	it("o clique (poke) em avatar assentado anima mesmo com outro no loop", () => {
		const fake = fakeEnv();
		const ticker = createTicker(fake.env);
		const mk = (seed: string, breathe: boolean) => {
			const engine = createAvatarEngine({ shape: "hex", seed, breathe });
			const applied: Frame[] = [];
			const handle = ticker.register({
				engine,
				apply: (f) => applied.push(f),
				follow: "off",
				getCenter: () => ({ x: 0, y: 0 }),
			});
			return { engine, applied, handle };
		};
		const quiet = mk("quieto", false);
		mk("ocupado", true);
		fake.frames(5);
		const before = quiet.applied.length;
		quiet.handle.interact((e) => e.poke(0, 0));
		fake.frames(30);
		expect(quiet.applied.length - before).toBeGreaterThan(3);
	});
});

describe("ticker: um loop e um listener para todos", () => {
	it("três avatares: 1 listener de pointermove e no máximo 1 rAF pendente", () => {
		const fake = fakeEnv();
		const ticker = createTicker(fake.env);
		const handles = ["a", "b", "c"].map((seed) =>
			ticker.register({
				engine: createAvatarEngine({ shape: "blob", seed, breathe: true }),
				apply: () => {},
				follow: "always",
				getCenter: () => ({ x: 0, y: 0 }),
			}),
		);
		expect(fake.pointerListeners).toBe(1);
		for (let i = 0; i < 30; i++) {
			fake.frame();
			expect(fake.pendingRafs).toBeLessThanOrEqual(1);
		}
		handles[0]?.unregister();
		handles[1]?.unregister();
		expect(fake.pointerListeners).toBe(1);
		handles[2]?.unregister();
		expect(fake.pointerListeners).toBe(0);
		expect(ticker.stats().entries).toBe(0);
	});
});

describe("ticker: pausa", () => {
	it("aba oculta cancela rAF e timer; ao voltar, retoma", () => {
		const { fake, ticker, engine } = setup({ breathe: true });
		fake.frames(3);
		expect(ticker.stats().looping).toBe(true);
		fake.setHidden(true);
		expect(fake.pendingRafs).toBe(0);
		expect(fake.pendingTimers).toBe(0);
		fake.elapse(5000);
		expect(ticker.stats().looping).toBe(false);
		fake.setHidden(false);
		expect(ticker.stats().looping).toBe(true);
		fake.frames(3);
		expect(engine.isSettled()).toBe(false);
	});

	it("o tempo escondido não vira um salto: o primeiro dt ao voltar é pequeno", () => {
		const { fake, advances } = setup({ breathe: true });
		fake.frames(5);
		fake.setHidden(true);
		fake.elapse(60_000);
		fake.setHidden(false);
		advances.length = 0;
		fake.frames(5);
		expect(advances.length).toBeGreaterThan(0);
		for (const dt of advances) expect(dt).toBeLessThan(40);
	});

	it("fora da tela não avança nem escreve; ao voltar, retoma", () => {
		const element = {} as Element;
		const { fake, ticker, applied } = setup({ breathe: true, element });
		fake.frames(3);
		fake.setVisible(element, false);
		const before = applied.length;
		fake.frames(20);
		expect(applied.length).toBe(before);
		expect(ticker.stats().looping).toBe(false);
		fake.setVisible(element, true);
		fake.frames(5);
		expect(applied.length).toBeGreaterThan(before);
	});

	it("observador que repete o mesmo valor não reinicia nada (sem oscilar)", () => {
		const element = {} as Element;
		const { fake, ticker } = setup({ breathe: true, element });
		fake.frames(2);
		const requests = fake.rafRequests;
		for (let i = 0; i < 10; i++) fake.setVisible(element, true);
		expect(fake.rafRequests).toBe(requests);
		expect(ticker.stats().looping).toBe(true);
	});
});

describe("ticker: seguir o mouse", () => {
	it("o olhar vai para o lado do mouse e o loop dorme de novo ao assentar", () => {
		const { fake, ticker, applied } = setup({ follow: "always" });
		fake.movePointer(260, 100);
		fake.frames(60);
		const last = applied[applied.length - 1] as Frame;
		expect((applied[0] as Frame).orientation.yaw).toBe(0);
		// o olhar gira o corpo para o lado do mouse (modo "sempre" soma 55% do máximo)
		expect(last.orientation.yaw).toBeGreaterThan(5);
		expect(ticker.stats().looping).toBe(false);
		fake.leavePointer();
		fake.frames(60);
		expect((applied[applied.length - 1] as Frame).orientation.yaw).toBeCloseTo(0, 1);
	});

	it("follow=off ignora o mouse; hover só olha com o mouse em cima", () => {
		const off = setup({ follow: "off" });
		off.fake.movePointer(260, 100);
		off.fake.frames(30);
		expect(off.ticker.stats().looping).toBe(false);

		const hover = setup({ follow: "hover" });
		hover.fake.movePointer(260, 100);
		hover.fake.frames(30);
		expect(hover.ticker.stats().looping).toBe(false);
		hover.handle.setHovered(true);
		hover.fake.frames(60);
		const frame = hover.applied[hover.applied.length - 1] as Frame;
		expect(frame.orientation.yaw).toBeGreaterThan((hover.applied[0] as Frame).orientation.yaw + 5);
	});
});

describe("REGRESSÃO do pisca-pisca (tremor com o mouse em movimento)", () => {
	// Causa raiz: o dt de cada quadro misturava duas bases de tempo
	// (performance.now() ao acordar por pointermove × timestamp do rAF). O
	// now() vem à frente do ts do rAF, então o dt do quadro seguinte saía
	// ~6 ms menor, caía abaixo do intervalo mínimo e o quadro era PULADO:
	// o avatar atualizava em quadros alternados (16 ms / 33 ms). Agora o dt só
	// usa o ts do rAF.
	it("com o mouse mexendo todo quadro, avança TODO quadro, com dt regular", () => {
		const { fake, advances, applied } = setup({ follow: "always", drift: 6 });
		fake.frames(2);
		advances.length = 0;
		const appliedBefore = applied.length;
		const FRAMES = 120;
		for (let i = 0; i < FRAMES; i++) {
			fake.movePointer(150 + ((i * 7) % 200), 100 + ((i * 13) % 120));
			fake.frame();
		}
		
		// nenhum quadro pulado (tolera 2 de ancoragem)
		expect(advances.length).toBeGreaterThanOrEqual(FRAMES - 2);
		expect(applied.length - appliedBefore).toBeGreaterThanOrEqual(FRAMES - 3);
		// dt sempre ≈ 16,7 ms: nada de 8 ms / 25 ms alternados nem negativo
		for (const dt of advances) {
			expect(dt).toBeGreaterThan(FRAME_MS - 1);
			expect(dt).toBeLessThan(FRAME_MS + 1);
		}
	});

	it("o mesmo vale quando now() fica ATRÁS do ts do rAF", () => {
		const { fake, advances } = setup({ follow: "always", drift: -9 });
		fake.frames(2);
		advances.length = 0;
		for (let i = 0; i < 60; i++) {
			fake.movePointer(150 + ((i * 11) % 180), 120);
			fake.frame();
		}
		expect(advances.length).toBeGreaterThanOrEqual(58);
		for (const dt of advances) expect(dt).toBeGreaterThan(0);
	});

	it("o quadro assentado é idêntico entre leituras (nada a reescrever no DOM)", () => {
		const { fake, engine } = setup({ seed: "estavel" });
		fake.elapse(100);
		const a = engine.snapshot();
		const b = engine.snapshot();
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("ticker: cérebro do avatar", () => {
	it("enquanto o cérebro está ativo o loop não dorme, mesmo sem clipe nem olhar; ao parar, dorme de novo", () => {
		const { fake, ticker, engine, handle } = setup({ seed: "cerebro", breathe: false });
		expect(ticker.stats().looping).toBe(false);
		handle.interact((e) => {
			e.setActivity("code");
			e.pulse("toolStart", 1);
		});
		fake.frames(60 * 10);
		expect(ticker.stats().looping).toBe(true);
		expect(engine.isSettled()).toBe(false);
		handle.interact((e) => e.setActivity(null));
		let frames = 0;
		while (ticker.stats().looping && frames < 60 * 30) {
			fake.frame();
			frames++;
		}
		expect(ticker.stats().looping).toBe(false);
		expect(ticker.stats().sleepTimer).toBe(true);
		expect(engine.isSettled()).toBe(true);
	});

	it("fora da tela ou com a aba oculta o cérebro não consome quadros", () => {
		const element = {} as Element;
		const { fake, ticker, handle, advances } = setup({ seed: "cerebro-2", breathe: false, element });
		handle.interact((e) => e.setActivity("search"));
		fake.frames(30);
		const running = advances.length;
		expect(running).toBeGreaterThan(10);
		fake.setVisible(element, false);
		fake.frames(60);
		expect(advances.length).toBe(running);
		fake.setVisible(element, true);
		fake.setHidden(true);
		expect(ticker.stats().looping).toBe(false);
		fake.frames(60);
		expect(advances.length).toBe(running);
		fake.setHidden(false);
		fake.frames(10);
		expect(advances.length).toBeGreaterThan(running);
	});
});
