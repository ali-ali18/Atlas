// StateMachine: decide O QUE o personagem faz sozinho. Piscadas e olhadas
// vêm de um gerador com semente (hash do id): dois avatares nunca piscam em
// uníssono, e os testes reproduzem a mesma sequência. O tempo só anda por
// `advance(dt)`; não há relógio aqui.
//
// Os estados vêm da tabela do app de referência (states.ts): cada um toca
// clipes sorteados de uma bolsa sem repetição, tem rosto próprio e, nos de
// resultado, volta sozinho (`next`/`holdSeconds`).
import { between, rng } from "../geometry/math.js";
import type { Character } from "./character.js";
import type { ClipEvent } from "./clip-player.js";
import type { Expression } from "./expressions.js";
import { indicatorFor } from "./indicator.js";
import { ClipBag, resolveState, stateDef, type AvatarState } from "./states.js";

export type { AvatarState } from "./states.js";

export const BEHAVIOR_TUNING = {
	blinkMinS: 2,
	blinkMaxS: 6,
	restBlinkMinS: 8,
	restBlinkMaxS: 14,
	doubleBlinkChance: 0.18,
	doubleBlinkGapS: 0.28,
	lookMinS: 3,
	lookMaxS: 8,
	thinkLookMinS: 1.2,
	thinkLookMaxS: 2.6,
	/** Cutucadas dentro da janela que irritam o avatar. */
	angryPokes: 5,
	angryWindowS: 2.5,
	angryHoldS: 4,
	calmHoldS: 1.2,
	pokeExpressionS: 1.6,
	compactGazeGain: 0.6,
	/** Abaixo disto (px) o avatar vira "compacto". */
	compactBelowPx: 32,
	/** Abaixo disto (px) só toca o clipe discreto (`compactClips`) e não gira. */
	compactClipsBelowPx: 32, // 48 é o valor da referência; em 36 px o Idle_B (±8,7°) não se vê
	/** Abaixo disto (px) só pisca: sem olhadas aleatórias (poupa CPU em listas). */
	looksFromPx: 64,
} as const;

const B = BEHAVIOR_TUNING;

/** Expressões da cutucada, em ciclo. */
export const POKE_CYCLE: readonly Expression[] = ["happy", "surprised", "confused"];

export type BehaviorOptions = {
	seed: number;
	/** Vivo: no estado `idle` toca os clipes de repouso (respira). Desligado, assenta e dorme. */
	breathe?: boolean;
};

export class StateMachine {
	private readonly random: () => number;
	private readonly bag: ClipBag;
	private readonly liveRequested: boolean;
	private state: AvatarState = "idle";
	private explicit: Expression | null = null;
	private emphasized = false;
	private compact = false;
	private compactClips = false;
	private resting = false;
	private looks = true;

	private clock = 0;
	private blinkIn: number;
	private lookIn: number;
	private pokeLeft = 0;
	private pokeExpression: Expression = "neutral";
	private pokeCount = 0;
	private pokeTimes: number[] = [];
	private angryLeft = 0;
	private calmLeft = 0;

	// clipes
	private stateTime = 0;
	private sequenceIndex = 0;
	private loadedOnce = false;

	constructor(
		private readonly character: Character,
		opts: BehaviorOptions,
	) {
		this.random = rng(opts.seed);
		// Bolsa e fase inicial com sementes derivadas: não mexem na sequência das piscadas.
		this.bag = new ClipBag(opts.seed ^ 0x9e3779b9);
		this.liveRequested = opts.breathe !== false;
		this.blinkIn = this.nextBlink();
		this.lookIn = this.nextLook();
		character.onClipEvent = (event) => this.onClipEvent(event);
		this.enterState();
		this.apply();
	}

	get currentState(): AvatarState {
		return this.state;
	}

	get isAngry(): boolean {
		return this.angryLeft > 0;
	}

	setState(next: AvatarState): void {
		if (next === this.state) return;
		this.state = next;
		this.lookIn = this.nextLook();
		this.enterState();
		this.apply();
	}

	/** Expressão pedida de fora (prop); `null` volta ao padrão do estado. */
	setExpression(expression: Expression | null): void {
		this.explicit = expression;
		this.apply();
	}

	setEmphasis(on: boolean): void {
		this.emphasized = on;
		this.character.setEmphasis(on);
		this.apply();
	}

	setCompact(on: boolean): void {
		this.compact = on;
		this.apply();
	}

	/** Avatar pequeno (lista): no repouso só o clipe discreto. */
	setCompactClips(on: boolean): void {
		if (on === this.compactClips) return;
		this.compactClips = on;
		if (this.isAmbient()) this.pickClip();
	}

	setResting(on: boolean): void {
		if (on === this.resting) return;
		this.resting = on;
		this.blinkIn = this.nextBlink();
		this.pickClip();
		this.apply();
	}

	/** Olhadas aleatórias ligadas/desligadas (avatar pequeno só pisca). */
	setLooks(on: boolean): void {
		this.looks = on;
	}

	/** Dispara um giro de 360° (ex.: quando `spinSignal` muda). */
	spin(): void {
		this.character.spin();
	}

	poke(x: number, y: number): void {
		this.character.poke(x, y);
		this.pokeTimes = this.pokeTimes.filter((t) => this.clock - t <= B.angryWindowS);
		this.pokeTimes.push(this.clock);
		if (this.pokeTimes.length >= B.angryPokes || this.angryLeft > 0) {
			this.angryLeft = B.angryHoldS;
			this.calmLeft = 0;
			this.pokeLeft = 0;
			this.pokeTimes = [];
		} else {
			this.pokeExpression = POKE_CYCLE[this.pokeCount % POKE_CYCLE.length] as Expression;
			this.pokeCount += 1;
			this.pokeLeft = B.pokeExpressionS;
		}
		this.apply();
	}

	advance(dt: number): void {
		if (!(dt > 0)) return;
		this.clock += dt;
		this.stateTime += dt;
		let dirty = false;

		this.blinkIn -= dt;
		if (this.blinkIn <= 0) {
			const awake = resolveState(this.state) !== "sleeping";
			if (awake) this.character.blink();
			this.blinkIn =
				awake && this.random() < B.doubleBlinkChance
					? B.doubleBlinkGapS
					: this.nextBlink();
		}

		if (this.looksEnabled()) {
			this.lookIn -= dt;
			if (this.lookIn <= 0) {
				this.glance();
				this.lookIn = this.nextLook();
			}
		}

		if (this.pokeLeft > 0) {
			this.pokeLeft = Math.max(0, this.pokeLeft - dt);
			dirty = dirty || this.pokeLeft === 0;
		}
		if (this.angryLeft > 0) {
			this.angryLeft = Math.max(0, this.angryLeft - dt);
			if (this.angryLeft === 0) this.calmLeft = B.calmHoldS;
			dirty = dirty || this.angryLeft === 0;
		} else if (this.calmLeft > 0) {
			this.calmLeft = Math.max(0, this.calmLeft - dt);
			dirty = dirty || this.calmLeft === 0;
		}

		// Reação com retorno automático (finished → idle, blocked → drowsy…).
		const def = stateDef(this.state);
		if (def.next && def.holdSeconds !== undefined && this.stateTime >= def.holdSeconds) {
			this.setState(def.next as AvatarState);
			return;
		}
		if (dirty) this.apply();
	}

	/** Segundos até o próximo evento agendado (Infinity = nada agendado). */
	nextWakeS(): number {
		let soonest = Number.POSITIVE_INFINITY;
		const consider = (left: number) => {
			if (left > 0) soonest = Math.min(soonest, left);
		};
		if (resolveState(this.state) !== "sleeping") consider(this.blinkIn);
		if (this.looksEnabled()) consider(this.lookIn);
		consider(this.pokeLeft);
		consider(this.angryLeft);
		consider(this.calmLeft);
		const def = stateDef(this.state);
		if (def.next && def.holdSeconds !== undefined) consider(def.holdSeconds - this.stateTime);
		return soonest;
	}

	// ------------------------------------------------------------------- clipes

	/** O repouso (`idle`) só anima quando o avatar é "vivo"; os demais estados sempre. */
	private isAmbient(): boolean {
		return resolveState(this.state) === "idle";
	}

	private enterState(): void {
		this.stateTime = 0;
		this.sequenceIndex = 0;
		// O corpo vira o indicador do estado (radar, órbita, anel…) e volta ao sair.
		this.character.setIndicator(indicatorFor(stateDef(this.state).morph));
		this.pickClip();
	}

	private clipList(): readonly string[] {
		const def = stateDef(this.state);
		return this.compactClips && def.compactClips ? def.compactClips : def.clips;
	}

	/** Estado em sequência: toca cada clipe uma vez, em ordem, e depois vai para `next`. */
	private isSequence(): boolean {
		const def = stateDef(this.state);
		return def.next !== undefined && def.holdSeconds === undefined;
	}

	private pickClip(): void {
		const parado = this.resting || (this.isAmbient() && !this.liveRequested);
		if (parado) {
			this.character.stopClip();
			return;
		}
		const list = this.clipList();
		const sequence = this.isSequence();
		const name = sequence ? (list[this.sequenceIndex] as string) : this.bag.next(list);
		// O primeiro clipe do avatar começa numa fase sorteada: avatares lado a lado não sincronizam.
		const phase = !this.loadedOnce && !sequence ? this.bag.phase() : 0;
		this.loadedOnce = true;
		this.character.playClip(name, { phase });
	}

	private onClipEvent(event: ClipEvent): void {
		if (event.type === "expression") {
			this.apply();
			return;
		}
		if (event.type !== "end") return;
		const def = stateDef(this.state);
		if (this.isSequence()) {
			this.sequenceIndex += 1;
			if (this.sequenceIndex >= this.clipList().length) {
				this.setState(def.next as AvatarState);
				return;
			}
		}
		this.pickClip();
	}

	// ----------------------------------------------------------------- olhadas

	private looksEnabled(): boolean {
		return this.looks && !this.compact && !this.resting && resolveState(this.state) !== "sleeping";
	}

	private nextBlink(): number {
		return this.resting
			? between(this.random, B.restBlinkMinS, B.restBlinkMaxS)
			: between(this.random, B.blinkMinS, B.blinkMaxS);
	}

	private nextLook(): number {
		return resolveState(this.state) === "thinking"
			? between(this.random, B.thinkLookMinS, B.thinkLookMaxS)
			: between(this.random, B.lookMinS, B.lookMaxS);
	}

	private glance(): void {
		const up = resolveState(this.state) === "thinking" ? 0.5 : 0;
		const dir = {
			x: between(this.random, -0.9, 0.9),
			y: between(this.random, -0.5, 0.5) - up,
		};
		this.character.look(dir, between(this.random, 0.7, 1.4));
	}

	/** Rosto: raiva > calma > cutucada > prop > rosto do estado > expressão do clipe. */
	private desired(): Expression {
		if (this.angryLeft > 0) return "angry";
		if (this.calmLeft > 0) return "calm";
		if (this.pokeLeft > 0) return this.pokeExpression;
		if (this.explicit) return this.explicit;
		const face = stateDef(this.state).face;
		if (face) return face;
		return this.character.clipExpression;
	}

	/** Empurra configurações derivadas para o Character. */
	private apply(): void {
		this.character.setExpression(this.desired());
		this.character.setShaking(this.angryLeft > 0);
		this.character.setGazeGain(this.compact ? B.compactGazeGain : 1);
	}
}
