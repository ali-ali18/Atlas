// Tabela de estados do personagem (a do app de referência): cada estado diz
// quais clipes tocar (sorteados de uma "bolsa" sem repetição), o rosto, o
// morph de indicador (o corpo vira radar, órbita, anel…) e, nos estados de
// resultado, para onde voltar (`next`) e depois de quanto tempo (`holdSeconds`).
import { rng } from "../geometry/math.js";
import type { Expression } from "./expressions.js";

export type MorphName =
	| "thinking"
	| "orbit"
	| "radar"
	| "progress"
	| "spawning"
	| "dictating"
	| "sending"
	| "receiving"
	| "uploading"
	| "writing"
	| "alerting"
	| "bouncing"
	| "powering-down";

export type StateDef = {
	clips: readonly string[];
	/** Em avatar pequeno só estes clipes (discretos). */
	compactClips?: readonly string[];
	face?: Expression;
	morph?: MorphName;
	next?: string;
	holdSeconds?: number;
};

const WORKING: StateDef = {
	clips: ["Working_A", "Working_B", "Working_C", "Working_D", "Working_E", "Working_F"],
};

/** Segundos até o bloqueio cansar (blocked → drowsy). */
const BLOCKED_HOLD_S = 120;

export const STATE_TABLE = {
	// repouso (a repetição de Idle_B é o peso do sorteio: 3 de 5)
	idle: { clips: ["Idle_B", "Idle_B", "Idle_D", "Idle_B", "Idle_A"], compactClips: ["Idle_B"] },
	listening: { clips: ["Idle_D"], face: "calm" },
	// conversa
	thinking: { clips: ["Idle_B"], morph: "thinking" },
	streaming: { clips: ["Streaming_A", "Streaming_B", "Streaming_C"] },
	// trabalho
	searching: { clips: ["Idle_B"], morph: "radar" },
	reading: WORKING,
	working: WORKING,
	coding: WORKING,
	running: WORKING,
	computing: WORKING,
	controlling: WORKING,
	waiting: { clips: ["Idle_B"], morph: "orbit" },
	// resultado
	blocked: { clips: ["Blocked_A"], next: "drowsy", holdSeconds: BLOCKED_HOLD_S },
	finished: { clips: ["Done_B", "Done_A"], face: "happy", next: "idle" },
	failed: { clips: ["Blocked_B"], next: "idle" },
	sleeping: { clips: ["Idle_B"], face: "sleepy" },
	waking: { clips: ["Idle_B"], face: "surprised", next: "idle", holdSeconds: 1.6 },
	// emoções
	happy: { clips: ["Done_A"] },
	excited: { clips: ["Done_C"] },
	laughing: { clips: ["Done_B"] },
	proud: { clips: ["Marketing_B"] },
	curious: { clips: ["Working_B"], face: "inspecting" },
	playful: { clips: ["Bodymoves_A"] },
	shy: { clips: ["Idle_D"], face: "calm" },
	surprised: { clips: ["Idle_B"], face: "surprised" },
	suspicious: { clips: ["Idle_D"], face: "squinted" },
	angry: { clips: ["Blocked_A"], face: "squinted" },
	confused: { clips: ["Blocked_A"] },
	sad: { clips: ["Blocked_B"] },
	drowsy: { clips: ["Blocked_C"] },
	bored: { clips: ["Idle_B"], face: "sleepy" },
	scared: { clips: ["Idle_D"], face: "surprised" },
	// comemoração
	celebrate: { clips: ["Rotation_A"], face: "happy" },
	approving: { clips: ["Rotation_C"], next: "idle" },
	// morphs de indicador
	orbit: { clips: ["Idle_B"], morph: "orbit" },
	radar: { clips: ["Idle_B"], morph: "radar" },
	progress: { clips: ["Idle_B"], morph: "progress" },
	spawning: { clips: ["Idle_B"], morph: "spawning" },
	loading: { clips: ["Idle_B"], morph: "progress" },
	dictating: { clips: ["Idle_B"], morph: "dictating" },
	sending: { clips: ["Idle_B"], morph: "sending" },
	receiving: { clips: ["Idle_B"], morph: "receiving" },
	uploading: { clips: ["Idle_B"], morph: "uploading" },
	writing: { clips: ["Idle_B"], morph: "writing" },
	alerting: { clips: ["Idle_B"], morph: "alerting" },
	bouncing: { clips: ["Idle_B"], morph: "bouncing" },
	"powering-down": { clips: ["Idle_B"], morph: "powering-down" },
	// produto
	humming: { clips: ["Idle_B"], face: "calm" },
	notifying: { clips: ["Done_B"], face: "surprised" },
	dragging: { clips: ["Idle_B"], face: "surprised" },
} as const satisfies Record<string, StateDef>;

export type AvatarState = keyof typeof STATE_TABLE | "sleep";

/** Apelido antigo → estado da tabela. */
export function resolveState(state: AvatarState): keyof typeof STATE_TABLE {
	return state === "sleep" ? "sleeping" : state;
}

export function stateDef(state: AvatarState): StateDef {
	return STATE_TABLE[resolveState(state)] as StateDef;
}

/**
 * Embaralha a lista (Fisher–Yates com o gerador da semente) e garante que o
 * primeiro clipe da bolsa não repita o último tocado (`previous`).
 */
export function shuffleBag(list: readonly string[], random: () => number, previous: string | null): string[] {
	const bag = [...list];
	for (let i = bag.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[bag[i], bag[j]] = [bag[j] as string, bag[i] as string];
	}
	const first = bag.findIndex((name) => name !== previous);
	if (first > 0) [bag[0], bag[first]] = [bag[first] as string, bag[0] as string];
	return bag;
}

/**
 * Bolsa sem repetição consecutiva: consome a lista embaralhada de cada estado
 * e nunca devolve o mesmo clipe duas vezes seguidas (havendo mais de um
 * clipe distinto). Mesma semente, mesma sequência.
 */
export class ClipBag {
	private readonly bags = new Map<string, string[]>();
	private readonly random: () => number;
	private last: string | null = null;

	constructor(seed: number) {
		this.random = rng(seed);
	}

	/** Sorteio inicial (fase do primeiro clipe); usa o mesmo gerador. */
	phase(): number {
		return this.random();
	}

	next(list: readonly string[]): string {
		const key = list.join("|");
		const distinct = new Set(list).size > 1;
		for (let guard = 0; guard < list.length * 2 + 2; guard++) {
			let bag = this.bags.get(key);
			if (!bag || bag.length === 0) {
				bag = shuffleBag(list, this.random, this.last);
				this.bags.set(key, bag);
			}
			const name = bag.shift() as string;
			if (!distinct || name !== this.last) {
				this.last = name;
				return name;
			}
		}
		this.last = list[0] as string;
		return this.last;
	}

	/** Esquece o último clipe (ao trocar de estado, o primeiro pode repetir o anterior de outro estado). */
	get previous(): string | null {
		return this.last;
	}
}
