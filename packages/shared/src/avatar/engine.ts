// Fachada do motor: Character (modelo) + StateMachine (comportamento) com a
// API em milissegundos que o ticker usa. Pura: o relógio é de quem chama.
import { clamp, hash } from "./geometry/math.js";
import { isShape, type Shape } from "./geometry/shapes.js";
import { Brain, brainLevel, familyOfState, type ActivityFamily, type PulseKind } from "./model/brain.js";
import type { BrainBudget } from "./model/brain-budget.js";
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
	/** Cérebro (movimento contínuo enquanto o bot trabalha). Desligue para comparar ou medir. */
	brain?: boolean;
	/** Vagas de cérebro compartilhadas entre avatares; sem ele, sem limite. */
	budget?: BrainBudget;
	/** Prioridade na disputa por vagas de cérebro (maior toma de menor). */
	brainPriority?: number;
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
	const brain = new Brain(seed ^ 0x51ed270b);
	const brainAllowed = opts.brain !== false;
	character.setBrain(brain.output);
	const budget = opts.budget;
	const slot = {};
	let holding = false;
	let sizeAllows = true;
	/** Liga o cérebro só se o avatar o quer, tem tamanho para isso e (com orçamento) tem vaga. */
	const updateBrain = () => {
		const on = brainAllowed && sizeAllows && (!budget || holding);
		brain.setEnabled(on);
		if (!on) behavior.setBlinkRate(1);
	};
	const releaseSlot = () => {
		if (!holding || !budget) return;
		budget.release(slot);
		holding = false;
		updateBrain();
	};
	// Família de atividade: vem do estado (lendo, programando…) ou de `setActivity`.
	let familyOverride: ActivityFamily | null = null;
	let family: ActivityFamily = "idle";
	/** Pulso que chegou antes de o cérebro ligar (o estado ainda não tinha chegado ao motor): vale por 1,5 s. */
	let pendingPulse: { kind: PulseKind; strength: number; until: number } | null = null;
	let clockMs = 0;
	const brainOn = () => brainAllowed && sizeAllows && (!budget || holding);
	/** Pede vaga a cada quadro enquanto quiser e não tiver (quem perdeu a disputa tenta de novo; quem voltou de pausa reassume). */
	const tryAcquire = () => {
		if (!budget || holding || !brainAllowed || !sizeAllows || brainLevel(family) <= 0) return;
		holding = budget.acquire(slot, {
			priority: opts.brainPriority,
			onEvict: () => {
				holding = false;
				updateBrain();
			},
		});
		if (holding) updateBrain();
	};
	const flushPulse = () => {
		if (!pendingPulse || !brainOn()) return;
		const pulse = pendingPulse;
		pendingPulse = null;
		if (clockMs <= pulse.until) brain.pulse(pulse.kind, pulse.strength);
	};
	const syncFamily = () => {
		const next = familyOverride ?? familyOfState(behavior.currentState);
		if (next !== family) {
			family = next;
			brain.setFamily(next);
		}
		tryAcquire();
		flushPulse();
	};
	const applySize = (size: number) => {
		sizeAllows = size >= BEHAVIOR_TUNING.compactBelowPx;
		updateBrain();
		behavior.setCompact(size < BEHAVIOR_TUNING.compactBelowPx);
		behavior.setCompactClips(size < BEHAVIOR_TUNING.compactClipsBelowPx);
		behavior.setLooks(size >= BEHAVIOR_TUNING.looksFromPx);
	};
	if (opts.size !== undefined) applySize(opts.size);
	else updateBrain();
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
				clockMs += dtMs;
				const seconds = dtMs / 1000;
				// O comportamento consome o tempo todo (inclusive o dormido); a
				// física anda em passos de no máximo 0,1 s.
				behavior.advance(seconds);
				syncFamily();
				if (brain.isActive) brain.advance(seconds);
				// Sempre sincroniza: com o cérebro desligado ou dormindo a taxa volta a 1.
				behavior.setBlinkRate(brain.output.blinkRate);
				if (holding && !brain.isActive) releaseSlot();
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
				clockMs += dtMs;
				behavior.advance(dtMs / 1000);
				syncFamily();
				activeLeft = Math.max(0, activeLeft - dtMs);
			}
			return character.frame();
		},
		/** Devolve a vaga de cérebro (ao desmontar o avatar). */
		dispose(): void {
			familyOverride = null;
			pendingPulse = null;
			releaseSlot();
		},
		/** Voltou à tela / aba visível: pede a vaga de novo (o loop está dormindo e não faria isso sozinho). */
		resume(): void {
			syncFamily();
		},
		/** Avatar parado (fora da tela, aba oculta): devolve a vaga; o próximo quadro pede de novo. */
		suspend(): void {
			pendingPulse = null;
			releaseSlot();
		},
		snapshot(): Frame {
			return character.frame();
		},
		isSettled(): boolean {
			return character.isSettled && !brain.isActive;
		},
		/** ms até o próximo evento agendado quando assentado (Infinity = nenhum). */
		nextWakeMs(): number {
			if (brain.isActive) return 0;
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
			syncFamily();
			touch();
		},
		/** Família de atividade do cérebro por cima do estado (ex.: `read`); `null` volta a derivar do estado. */
		setActivity(next: ActivityFamily | null): void {
			familyOverride = next;
			syncFamily();
			touch();
		},
		/** Evento pontual (ferramenta começou/acabou/falhou, rajada de texto): um gesto curto do cérebro. */
		pulse(kind: PulseKind, strength = 1): void {
			if (brainOn()) brain.pulse(kind, strength);
			else if (brainAllowed && sizeAllows) pendingPulse = { kind, strength, until: clockMs + 1500 };
			touch();
		},
		/** Família de atividade em uso (diagnóstico e testes). */
		activityFamily(): ActivityFamily {
			return family;
		},
		/** Peso atual do cérebro (0..1), para diagnóstico e testes. */
		brainWeight(): number {
			return brain.output.weight;
		},
		/** O bot está rodando: faz os gestos de trabalho. Volta a `idle` ao terminar. */
		setWorking(working: boolean): void {
			if (working) behavior.setState("working");
			else if (behavior.currentState === "working") behavior.setState("idle");
			syncFamily();
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
