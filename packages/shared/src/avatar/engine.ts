// Fachada do motor: Character (modelo) + StateMachine (comportamento) com a
// API em milissegundos que o ticker usa. Pura: o relógio é de quem chama.
import { clamp, hash } from "./geometry/math.js";
import { isShape, type Shape } from "./geometry/shapes.js";
import { Character, type Frame } from "./model/character.js";
import {
	BEHAVIOR_TUNING,
	StateMachine,
	type AvatarState,
} from "./model/behavior.js";
import { normalizeExpression, type Expression } from "./model/expressions.js";
import { indicatorFor } from "./model/indicator.js";
import type { MorphName } from "./model/states.js";

export type EngineOptions = {
	shape: Shape | string;
	/** Semente textual (ex.: id do bot): define os tempos de cada avatar. */
	seed: string;
	breathe?: boolean;
	/** Tamanho em px; abaixo de 32 vira compacto e abaixo de 64 não olha em volta. */
	size?: number;
};

/** Depois de uma interação o motor roda a 60 fps; fora disso, 30. */
const ACTIVE_MS = 1500;
const FRAME_ACTIVE_MS = 16;
const FRAME_AMBIENT_MS = 33;

export type AvatarEngine = ReturnType<typeof createAvatarEngine>;

export function createAvatarEngine(opts: EngineOptions) {
	const seed = hash(opts.seed);
	const shape: Shape = isShape(opts.shape) ? opts.shape : "blob";
	const character = new Character({ body: shape, seed, breathe: opts.breathe });
	const behavior = new StateMachine(character, { seed, breathe: opts.breathe });
	const applySize = (size: number) => {
		behavior.setCompact(size < BEHAVIOR_TUNING.compactBelowPx);
		behavior.setCompactClips(size < BEHAVIOR_TUNING.compactClipsBelowPx);
		behavior.setLooks(size >= BEHAVIOR_TUNING.looksFromPx);
	};
	if (opts.size !== undefined) applySize(opts.size);
	let activeLeft = 0;

	const touch = () => {
		activeLeft = ACTIVE_MS;
	};

	return {
		character,
		behavior,

		/** Avança `dtMs` milissegundos e devolve o quadro. */
		advance(dtMs: number): Frame {
			if (dtMs > 0) {
				const seconds = dtMs / 1000;
				// O comportamento consome o tempo todo (inclusive o dormido); a
				// física anda em passos de no máximo 0,1 s.
				behavior.advance(seconds);
				character.advance(clamp(seconds, 0, 0.1));
				activeLeft = Math.max(0, activeLeft - dtMs);
			}
			return character.frame();
		},
		/**
		 * Conta tempo em que o personagem ficou parado (dormindo): só o
		 * comportamento anda (piscada, olhadas, raiva); a física não, porque
		 * nada se mexia. Se um evento disparar, o personagem acorda.
		 */
		skip(dtMs: number): Frame {
			if (dtMs > 0) {
				behavior.advance(dtMs / 1000);
				activeLeft = Math.max(0, activeLeft - dtMs);
			}
			return character.frame();
		},
		snapshot(): Frame {
			return character.frame();
		},
		isSettled(): boolean {
			return character.isSettled;
		},
		/** ms até o próximo evento agendado quando assentado (Infinity = nenhum). */
		nextWakeMs(): number {
			return behavior.nextWakeS() * 1000;
		},
		frameIntervalMs(): number {
			return activeLeft > 0 ? FRAME_ACTIVE_MS : FRAME_AMBIENT_MS;
		},

		/** `additive`: soma ao clipe (painel que sempre segue); senão o olhar assume o corpo. */
		setGaze(vector: { x: number; y: number } | null, additive = false): void {
			character.setGaze(vector, additive);
			if (vector) touch();
		},
		poke(x = 0, y = 0): void {
			behavior.poke(x, y);
			touch();
		},
		blink(): void {
			character.blink();
			touch();
		},
		look(dir: { x: number; y: number }): void {
			character.look(dir);
			touch();
		},
		setBody(next: Shape | string, options?: { instant?: boolean }): void {
			character.setBody(isShape(next) ? next : "blob", options);
			touch();
		},
		setExpression(expression: Expression | string | null): void {
			behavior.setExpression(
				expression === null ? null : normalizeExpression(expression),
			);
			touch();
		},
		setState(state: AvatarState): void {
			behavior.setState(state);
			touch();
		},
		/** O bot está rodando: faz os gestos de trabalho. Volta a `idle` ao terminar. */
		setWorking(working: boolean): void {
			if (working) behavior.setState("working");
			else if (behavior.currentState === "working") behavior.setState("idle");
			touch();
		},
		/** O corpo vira um indicador (radar, órbita, progress, thinking…); `null` volta ao corpo. */
		setMorph(morph: MorphName | null): void {
			character.setIndicator(indicatorFor(morph));
			touch();
		},
		/** Fração real (0..1) do anel de progresso, ex.: passo 3 de 8; `null` volta ao anel em ciclo. */
		setProgress(fraction: number | null): void {
			character.setProgress(fraction);
			touch();
		},
		setEmphasis(on: boolean): void {
			behavior.setEmphasis(on);
			touch();
		},
		/** Tamanho em px: pequeno vira compacto (menos movimento) e só pisca. */
		setSize(size: number): void {
			applySize(size);
		},
		setResting(on: boolean): void {
			behavior.setResting(on);
		},
		spin(): void {
			behavior.spin();
			touch();
		},
	};
}
