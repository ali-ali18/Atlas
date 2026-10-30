// Character: o modelo PURO do avatar (sem DOM, sem relógio). Recebe `advance(dt)`
// e devolve um `frame()` (dados). Molas dão suavidade ao olhar, ao squash e ao
// morph; o tempo só passa por `advance`, então tudo é determinístico.
import { FACE_UNIT, EYE_FIT, eyeScales } from "../geometry/eyes.js";
import {
	TAU,
	clamp,
	lerp,
	smoothstep,
	snapSpring,
	spring,
	springSettled,
	stepSpring,
	type Spring,
} from "../geometry/math.js";
import { lerpOutline, mixOutlines, type MorphInput } from "../geometry/morph.js";
import {
	BODY_RADIUS_PX,
	CENTER,
	shapeFit,
	shapeOutline,
	type Outline,
	type Shape,
} from "../geometry/shapes.js";
import { ClipPlayer, type ClipEvent } from "./clip-player.js";
import { Indicator, type IndicatorFrame, type IndicatorKind } from "./indicator.js";
import { DEFAULT_ZOOM, unwrapAngle } from "./clips.js";
import {
	EXPRESSION_EYES,
	lerpPair,
	normalizeExpression,
	type EyePair,
	type Expression,
} from "./expressions.js";

export type EyeFrame = {
	/** Centro do olho, em unidades do SVG (viewBox 250). */
	cx: number;
	cy: number;
	/** Espessura e comprimento ponta a ponta. */
	width: number;
	length: number;
	/** Ângulo do eixo (graus, anti-horário, 0 = horizontal). */
	rot: number;
	/** Flecha da curvatura (positivo = "^"). */
	bend: number;
	/** O olho direito é o espelho do esquerdo. */
	mirror: boolean;
};

/** Orientação 3D do personagem, em graus (ver `rotationMatrix`). */
export type Orientation = { yaw: number; pitch: number; roll: number };

export type Frame = {
	/** Forma do corpo (define o sólido 3D); durante o morph, a de destino. */
	shape: Shape;
	/** Contorno atual do corpo: [x0, y0, ...]. */
	body: readonly number[];
	/** Muda sempre que o contorno muda (deixa o renderer pular o path do corpo). */
	bodyRev: number;
	eyes: readonly [EyeFrame, EyeFrame];
	/** Orientação 3D: o olhar gira o corpo (yaw/pitch); roll é o giro na tela. */
	orientation: Orientation;
	/** Escala do corpo no viewBox (enquadramento por forma); vale para o corpo e os olhos. */
	fit: number;
	/** Morph de indicador (radar, órbita, anel…) em andamento; `null` = corpo normal. */
	indicator: IndicatorFrame | null;
	/** Zoom do clipe relativo ao padrão (respiração, encolher): escala uniforme. */
	scale: number;
	/** Squash & stretch (clipe × toque). */
	scaleX: number;
	scaleY: number;
	/** Âncora do squash: 0 = centro, -1 = base do corpo (pulinhos). */
	squashAnchor: number;
	offsetX: number;
	offsetY: number;
};

export const CHARACTER_TUNING = {
	/**
	 * Olhar (valores do app de referência): o olhar GIRA o corpo. Graus de
	 * yaw/pitch com o olhar no máximo; a esfera (blob) gira menos que os sólidos.
	 */
	yawSphere: 18,
	pitchSphere: 14,
	yawSolid: 26,
	pitchSolid: 19,
	/** Deslocamento do corpo em direção ao olhar (em raios do corpo). */
	pushSphere: [0.03, 0.024],
	pushSolid: [0.07, 0.055],
	/** Formas que giram menos (o contorno já é ousado). */
	gazeGain: { heart: 0.6, wedge: 0.55 } as Partial<Record<Shape, number>>,
	/** Suavização do olhar por quadro a 60 fps (alvo e peso). */
	gazeSmooth: 0.14,
	/** No modo "sempre" o olhar soma por cima do clipe, com este peso. */
	gazeAdditive: 0.55,
	/** Resíduo do olhar nos olhos (px do viewBox): só para dar vida. */
	eyeResidualPx: 1.2,
	squashK: 220,
	squashD: 11,
	pokeImpulse: 2.6,
	pokePush: 90,
	morphK: 140,
	morphD: 24,
	blinkS: 0.12,
	blinkMin: 0.1,
	expressionS: 0.28,
	/** Giro de comemoração: yaw += 180 · (1 − cos πa) em 0,9 s (uma volta). */
	spinS: 0.9,
	shakeUnits: 1.6,
	shakeHz: 9,
	emphasisEyes: 1.12,
	maxStepS: 0.1,
} as const;

const T = CHARACTER_TUNING;
const SETTLE = 0.002;
/** Abaixo disto o olhar encosta no alvo (o loop pode dormir). */
const GAZE_EPS = 0.001;

export type CharacterOptions = {
	body: Shape;
	seed: number;
	/** Respiração contínua. Desligada, o personagem assenta e o loop dorme. */
	breathe?: boolean;
};

export class Character {
	private shape: Shape;
	/** Forma de onde o morph parte (para interpolar o enquadramento). */
	private fromShape: Shape;
	private time = 0;
	private paused = false;

	// corpo / morph
	private from: number[];
	private to: Outline;
	private mixed: number[];
	private readonly roundBuf: number[] = [];
	private readonly morph: Spring = spring(1);
	private bodyRev = 0;

	// expressão
	private exprFrom: EyePair;
	private exprTo: EyePair;
	private exprT = 1;
	private exprDur: number = T.expressionS;
	private expression: Expression = "neutral";

	// olhar: `gazeX/Y` é o alvo suavizado; `gazeHold` (0..1) é o quanto ele vale.
	private gazeX = 0;
	private gazeY = 0;
	private gazeHold = 0;
	private pointer: { x: number; y: number; additive: boolean } | null = null;
	private glance = { x: 0, y: 0 };
	private glanceLeft = 0;

	// toque
	private readonly squash = spring(0);
	private readonly pushX = spring(0);
	private readonly pushY = spring(0);

	// outros
	private blinkT: number | null = null;
	private spinT: number | null = null;
	private readonly shake = spring(0);
	private readonly emphasis = spring(0);
	private gazeGain = 1;

	// morph de indicador: o corpo vira radar, órbita, anel de progresso…
	private readonly indicator = new Indicator();

	// clipes de animação (keyframes do app de referência)
	private readonly player = new ClipPlayer((event) => this.handleClipEvent(event));
	/** Quem manda nos clipes ouve o fim de cada um e as trocas de expressão. */
	onClipEvent: ((event: ClipEvent) => void) | null = null;
	private clipExpr: Expression = "neutral";

	constructor(opts: CharacterOptions) {
		this.shape = opts.body;
		this.fromShape = opts.body;
		const outline = shapeOutline(opts.body);
		this.from = Array.from(outline);
		this.to = outline;
		this.mixed = Array.from(outline);
		this.exprFrom = EXPRESSION_EYES.neutral;
		this.exprTo = EXPRESSION_EYES.neutral;
	}

	private handleClipEvent(event: ClipEvent): void {
		if (event.type === "blink") this.blink();
		if (event.type === "expression") this.clipExpr = normalizeExpression(event.name);
		this.onClipEvent?.(event);
	}

	/** Expressão pedida pelo clipe em andamento (o rosto do estado pode se sobrepor). */
	get clipExpression(): Expression {
		return this.clipExpr;
	}

	/** Toca um clipe (com ponte suave desde a pose atual). */
	playClip(name: string, opts: { phase?: number; bridge?: boolean } = {}): void {
		this.player.load(name, opts);
	}

	/** Para o clipe e volta (com ponte) à pose de repouso. */
	stopClip(): void {
		this.player.rest();
		this.clipExpr = "neutral";
	}

	/** O corpo vira o indicador (ou volta, com `null`). */
	setIndicator(kind: IndicatorKind | null): void {
		this.indicator.set(kind);
	}

	/** Fração real do anel de progresso (`null` = anel em ciclo). */
	setProgress(fraction: number | null): void {
		this.indicator.setProgress(fraction);
	}

	get currentIndicator(): IndicatorKind | null {
		return this.indicator.current;
	}

	get clipName(): string | null {
		return this.player.name;
	}

	/** Quantas vezes um clipe chegou ao fim. */
	get clipLoops(): number {
		return this.player.loops;
	}

	// ------------------------------------------------------------------ comandos

	get currentShape(): Shape {
		return this.shape;
	}

	get currentExpression(): Expression {
		return this.expression;
	}

	/** Troca o corpo, com morph animado (ou instantâneo). */
	setBody(shape: Shape, opts: { instant?: boolean } = {}): void {
		this.fromShape = opts.instant ? shape : this.shape;
		this.shape = shape;
		this.retarget(shapeOutline(shape), opts.instant === true);
	}

	/** Mistura formas com pesos (ex.: 70% egg + 30% cloud). */
	setMorph(mix: readonly { shape: Shape; weight: number }[]): void {
		const inputs: MorphInput[] = mix.map((m) => ({
			outline: shapeOutline(m.shape),
			weight: m.weight,
		}));
		if (inputs.length === 0) return;
		const heaviest = mix.reduce((a, b) => (b.weight > a.weight ? b : a));
		this.fromShape = this.shape;
		this.shape = heaviest.shape;
		this.retarget(mixOutlines(inputs), false);
	}

	private retarget(outline: Outline, instant: boolean): void {
		this.bodyRev += 1;
		if (instant) {
			this.from = Array.from(outline);
			this.to = outline;
			this.morph.value = 1;
			this.morph.target = 1;
			this.morph.velocity = 0;
			this.mixed = Array.from(outline);
			return;
		}
		this.from = this.currentBody().slice();
		this.to = outline;
		this.morph.value = 0;
		this.morph.velocity = 0;
		this.morph.target = 1;
	}

	setExpression(next: Expression, opts: { duration?: number } = {}): void {
		if (next === this.expression && this.exprT >= 1) return;
		const duration = opts.duration ?? T.expressionS;
		this.exprFrom = this.currentPair();
		this.exprTo = EXPRESSION_EYES[next];
		this.exprT = duration <= 0 ? 1 : 0;
		this.exprDur = Math.max(duration, 1e-6);
		this.expression = next;
	}

	/**
	 * Olhar contínuo (ex.: seguir o mouse), em -1..1 (y para baixo, como na
	 * tela); `null` solta. `additive` soma por cima do clipe (painel que
	 * sempre segue o mouse); sem ele, o olhar assume o corpo (hover).
	 */
	setGaze(point: { x: number; y: number } | null, additive = false): void {
		if (!point) {
			this.pointer = null;
			return;
		}
		const len = Math.hypot(point.x, point.y);
		const k = len > 1 ? 1 / len : 1;
		this.pointer = { x: point.x * k, y: point.y * k, additive };
	}

	/** Olhadinha momentânea para uma direção (-1..1). */
	look(dir: { x: number; y: number }, seconds = 0.9): void {
		const len = Math.hypot(dir.x, dir.y);
		const k = len > 1 ? 1 / len : 1;
		this.glance = { x: dir.x * k, y: dir.y * k };
		this.glanceLeft = seconds;
	}

	blink(): void {
		if (this.blinkT === null) this.blinkT = 0;
	}

	/** Cutucada em (x, y) normalizado (-1..1): squash e olha para o ponto. */
	poke(x: number, y: number): void {
		const px = clamp(x, -1, 1);
		const py = clamp(y, -1, 1);
		this.squash.velocity += T.pokeImpulse;
		this.pushX.velocity -= px * T.pokePush;
		this.pushY.velocity -= py * T.pokePush;
		this.look({ x: px, y: py }, 0.8);
	}

	spin(): void {
		this.spinT = 0;
	}

	setShaking(shaking: boolean): void {
		this.shake.target = shaking ? 1 : 0;
	}

	setEmphasis(on: boolean): void {
		this.emphasis.target = on ? 1 : 0;
	}

	/** Multiplicador do olhar (modo compacto reduz). */
	setGazeGain(gain: number): void {
		this.gazeGain = gain;
	}

	play(): void {
		this.paused = false;
	}

	pause(): void {
		this.paused = true;
	}

	seek(seconds: number): void {
		this.time = Math.max(0, seconds);
	}

	// -------------------------------------------------------------------- tempo

	/** Integra molas e timers. `dt` em segundos (limitado a 0,1 s). */
	advance(dt: number): void {
		if (this.paused || !(dt > 0)) return;
		const h = Math.min(dt, T.maxStepS);
		this.time += h;

		// morph
		if (!springSettled(this.morph, SETTLE)) {
			this.bodyRev += 1;
			stepSpring(this.morph, h, T.morphK, T.morphD);
			if (springSettled(this.morph, SETTLE)) snapSpring(this.morph);
		}

		// expressão
		if (this.exprT < 1) {
			this.exprT = Math.min(1, this.exprT + h / this.exprDur);
		}

		// olhar
		if (this.glanceLeft > 0) this.glanceLeft = Math.max(0, this.glanceLeft - h);
		this.stepGaze(h);

		// toque
		this.step(this.squash, h, T.squashK, T.squashD);
		this.step(this.pushX, h, T.squashK, T.squashD);
		this.step(this.pushY, h, T.squashK, T.squashD);

		// clipe e indicador
		this.player.advance(h);
		this.indicator.advance(h);
		if (!this.indicator.isSettled) this.bodyRev += 1;

		// piscada e giro
		if (this.blinkT !== null) {
			this.blinkT += h;
			if (this.blinkT >= T.blinkS) this.blinkT = null;
		}
		if (this.spinT !== null) {
			this.spinT += h;
			if (this.spinT >= T.spinS) this.spinT = null;
		}

		// blends lentos
		this.step(this.shake, h, 80, 16);
		this.step(this.emphasis, h, 120, 20);
	}

	/** Alvo do olhar: ponteiro, senão olhadinha, senão nenhum (peso 0). */
	private gazeGoal(): { x: number; y: number; additive: boolean } | null {
		if (this.pointer) return this.pointer;
		if (this.glanceLeft > 0) return { ...this.glance, additive: false };
		return null;
	}

	/** Aproximação exponencial por quadro (0,14 a 60 fps), independente do dt. */
	private stepGaze(h: number): void {
		const goal = this.gazeGoal();
		const a = 1 - (1 - T.gazeSmooth) ** (h * 60);
		const near = (value: number, to: number) => {
			const next = value + (to - value) * a;
			return Math.abs(to - next) < GAZE_EPS ? to : next;
		};
		if (goal) {
			const gx = goal.x * this.gazeGain;
			const gy = goal.y * this.gazeGain;
			// O primeiro quadro do olhar parte do alvo: nada de arrastar do centro antigo.
			if (this.gazeHold === 0) {
				this.gazeX = gx;
				this.gazeY = gy;
			} else {
				this.gazeX = near(this.gazeX, gx);
				this.gazeY = near(this.gazeY, gy);
			}
		}
		this.gazeHold = near(this.gazeHold, goal ? 1 : 0);
	}

	private gazeSettled(): boolean {
		const goal = this.gazeGoal();
		if (!goal) return this.gazeHold === 0;
		return (
			this.gazeHold === 1 &&
			this.gazeX === goal.x * this.gazeGain &&
			this.gazeY === goal.y * this.gazeGain
		);
	}

	private step(s: Spring, h: number, k: number, d: number): void {
		if (springSettled(s, SETTLE)) {
			snapSpring(s);
			return;
		}
		stepSpring(s, h, k, d);
		if (springSettled(s, SETTLE)) snapSpring(s);
	}

	/** Tudo parado: o loop pode dormir. */
	get isSettled(): boolean {
		if (this.paused) return true;
		return (
			springSettled(this.morph, SETTLE) &&
			this.exprT >= 1 &&
			this.blinkT === null &&
			this.spinT === null &&
			this.glanceLeft <= 0 &&
			this.gazeSettled() &&
			springSettled(this.squash, SETTLE) &&
			springSettled(this.pushX, SETTLE) &&
			springSettled(this.pushY, SETTLE) &&
			this.player.isSettled &&
			this.indicator.isSettled &&
			springSettled(this.shake, SETTLE) &&
			springSettled(this.emphasis, SETTLE) &&
			this.shake.target === 0
		);
	}

	// -------------------------------------------------------------------- quadro

	private currentBody(): number[] {
		const t = clamp(this.morph.value, 0, 1);
		if (t >= 1) {
			for (let i = 0; i < this.to.length; i++) this.mixed[i] = this.to[i] as number;
			return this.mixed;
		}
		return lerpOutline(this.from, this.to, t, this.mixed);
	}

	private currentPair(): EyePair {
		if (this.exprT >= 1) return this.exprTo;
		return lerpPair(this.exprFrom, this.exprTo, smoothstep(this.exprT));
	}

	frame(): Frame {
		const pair = this.currentPair();
		const scales = eyeScales(this.shape);
		const fit = EYE_FIT[this.shape];
		const emph = lerp(1, T.emphasisEyes, this.emphasis.value);
		const lid =
			this.blinkT === null
				? 1
				: 1 - (1 - T.blinkMin) * Math.sin(Math.PI * (this.blinkT / T.blinkS));
		const gaze = this.gazePose();
		// Resíduo pequeno nos olhos (o corpo é quem gira).
		const residualX = gaze.hold * this.gazeX * T.eyeResidualPx;
		const residualY = gaze.hold * this.gazeY * T.eyeResidualPx;

		const eyeAt = (index: 0 | 1): EyeFrame => {
			const params = pair[index];
			const side = index === 0 ? -1 : 1;
			const length = Math.max(0.04, params.length * scales.h * emph * lid);
			const width = params.width * scales.w * emph;
			return {
				cx:
					CENTER +
					side * (fit.gap / 2 + params.dx * scales.gap) * FACE_UNIT +
					residualX,
				cy: CENTER - (fit.shiftY + params.dy * scales.h) * FACE_UNIT + residualY,
				width: width * FACE_UNIT,
				length: length * FACE_UNIT,
				rot: params.rot,
				bend: params.bend * scales.h * FACE_UNIT,
				mirror: index === 1,
			};
		};

		const pose = this.player.pose;
		const unit = BODY_RADIUS_PX * this.currentFit();
		const zoom = pose.zoom / DEFAULT_ZOOM;
		const shake = this.shake.value;
		const shakeX = shake * T.shakeUnits * Math.sin(TAU * T.shakeHz * this.time);
		// Giro de comemoração (poke "spin" da referência): yaw += 180 · (1 − cos πa).
		const spin =
			this.spinT === null ? 0 : 180 * (1 - Math.cos(Math.PI * (this.spinT / T.spinS)));
		const orientation = this.orientation(pose.rot, gaze, spin);
		const pos = this.position(pose.pos, gaze);

		const ind = this.indicator.frame();
		const body = ind && ind.round > 0 ? this.roundedBody(ind.round) : this.currentBody();
		const bodyFit = ind
			? lerp(this.currentFit(), shapeFit("blob"), ind.round) * ind.core
			: this.currentFit();

		return {
			shape: ind ? "blob" : this.shape,
			body,
			bodyRev: this.bodyRev,
			eyes: [eyeAt(0), eyeAt(1)],
			orientation: ind ? { yaw: 0, pitch: 0, roll: 0 } : orientation,
			fit: bodyFit,
			indicator: ind,
			scale: ind ? zoom * ind.zoom : zoom,
			scaleX: pose.squash[0] * (1 + this.squash.value),
			scaleY: pose.squash[1] * (1 - this.squash.value * 0.9),
			squashAnchor: this.player.anchor,
			offsetX: this.pushX.value + pos[0] * unit * zoom + shakeX,
			offsetY: this.pushY.value - pos[1] * unit * zoom + (ind ? ind.lift : 0),
		};
	}

	/** Contorno atual misturado ao círculo (o corpo virando o núcleo do indicador). */
	private roundedBody(round: number): number[] {
		const circle = shapeOutline("blob");
		const current = this.currentBody();
		for (let i = 0; i < current.length; i++) {
			this.roundBuf[i] = lerp(current[i] as number, circle[i] as number, round);
		}
		return this.roundBuf;
	}

	/**
	 * Orientação final: a do clipe [pitch, yaw, roll] com o olhar. Modo
	 * "assume" (hover): o olhar substitui a rotação do clipe pelo peso `hold`
	 * (o roll some); modo aditivo: soma 55% por cima.
	 */
	private orientation(
		rot: readonly [number, number, number],
		gaze: GazePose,
		spin: number,
	): Orientation {
		const [pitch, yaw, roll] = rot;
		if (gaze.hold === 0) return { yaw: yaw + spin, pitch, roll };
		if (gaze.additive) {
			return { yaw: yaw + gaze.yaw + spin, pitch: pitch + gaze.pitch, roll };
		}
		const h = gaze.hold;
		return {
			yaw: lerp(yaw, unwrapAngle(gaze.yaw, yaw), h) + spin,
			pitch: lerp(pitch, unwrapAngle(gaze.pitch, pitch), h),
			roll: roll * (1 - h),
		};
	}

	/** Posição (raios do corpo, y para cima): clipe + empurrão do olhar. */
	private position(pos: readonly [number, number], gaze: GazePose): [number, number] {
		if (gaze.hold === 0) return [pos[0], pos[1]];
		if (gaze.additive) return [pos[0] + gaze.pushX, pos[1] + gaze.pushY];
		const h = gaze.hold;
		return [lerp(pos[0], gaze.pushX, h), lerp(pos[1], gaze.pushY, h)];
	}

	/** Enquadramento atual: interpola o da forma de origem ao da de destino no morph. */
	private currentFit(): number {
		const t = clamp(this.morph.value, 0, 1);
		return lerp(shapeFit(this.fromShape), shapeFit(this.shape), t);
	}

	/**
	 * Pose do olhar (app de referência): yaw/pitch (graus) e empurrão (raios do
	 * corpo, y para cima) que o olhar pede quando está 100% valendo; `hold` é
	 * o peso (0..1). Sólidos giram mais que a esfera.
	 */
	private gazePose(): GazePose {
		const hold = this.gazeHold;
		const additive = this.pointer?.additive === true;
		if (hold === 0) return { hold, additive, yaw: 0, pitch: 0, pushX: 0, pushY: 0 };
		const sphere = this.shape === "blob";
		const gain = T.gazeGain[this.shape] ?? 1;
		const w = additive ? T.gazeAdditive * hold : hold;
		const yawMax = sphere ? T.yawSphere : T.yawSolid;
		const pitchMax = sphere ? T.pitchSphere : T.pitchSolid;
		const [pushX, pushY] = sphere ? T.pushSphere : T.pushSolid;
		// A tela cresce para baixo e o pitch positivo também olha para baixo.
		const scale = additive ? w : 1;
		return {
			hold,
			additive,
			yaw: yawMax * gain * this.gazeX * scale,
			pitch: pitchMax * gain * this.gazeY * scale,
			pushX: pushX * this.gazeX * scale,
			pushY: -pushY * this.gazeY * scale,
		};
	}
}

type GazePose = {
	hold: number;
	additive: boolean;
	yaw: number;
	pitch: number;
	pushX: number;
	pushY: number;
};
