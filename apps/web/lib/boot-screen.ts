// Tela de carregamento da abertura do app: só o avatar. Regras puras (testáveis) + o sinal
// "o app carregou" que o resto da interface dispara.

/** Se o app ficar pronto antes disto, não mostra a dança (evita piscar). */
export const BOOT_DANCE_AFTER_MS = 300
/** Depois que a dança começa, fica pelo menos isto na tela (não corta no meio). */
export const BOOT_MIN_DANCE_MS = 700
/** Duração do fade de saída. */
export const BOOT_FADE_MS = 280
/** Trava de segurança: some mesmo que o app nunca avise que carregou. */
export const BOOT_MAX_MS = 10_000

export type BootAction = "still" | "dance" | "hide"

/** Decide o que a tela faz agora. `elapsedMs` conta desde a hidratação. */
export function bootAction(elapsedMs: number, ready: boolean, danceStartedMs: number | null): BootAction {
	if (elapsedMs >= BOOT_MAX_MS) return "hide"
	if (danceStartedMs === null) {
		if (ready) return "hide"
		return elapsedMs >= BOOT_DANCE_AFTER_MS ? "dance" : "still"
	}
	if (ready && elapsedMs - danceStartedMs >= BOOT_MIN_DANCE_MS) return "hide"
	return "dance"
}

export type BootPose = { state: "playful" | "excited" | "laughing"; expression: string; spins: number }

type Beat = { at: number; expression: string; spin?: boolean }
type Move = { state: BootPose["state"]; ms: number; beats: Beat[] }

/** Coreografia em loop: cada movimento é um clipe do motor; os olhos mudam dentro dele. */
export const BOOT_MOVES: readonly Move[] = [
	{
		state: "playful", // Bodymoves_A: balança para os lados e gira no fim
		ms: 5000,
		beats: [
			{ at: 0, expression: "happy" },
			{ at: 800, expression: "surprised" },
			{ at: 1500, expression: "squinted" },
			{ at: 2200, expression: "happy" },
			{ at: 3000, expression: "neutral", spin: true },
			{ at: 3800, expression: "happy" },
			{ at: 4400, expression: "surprised" },
		],
	},
	{
		state: "excited", // Done_C
		ms: 2000,
		beats: [
			{ at: 0, expression: "happy" },
			{ at: 900, expression: "surprised" },
		],
	},
	{
		state: "laughing", // Done_B
		ms: 1700,
		beats: [
			{ at: 0, expression: "squinted" },
			{ at: 800, expression: "happy" },
		],
	},
]

const LOOP_MS = BOOT_MOVES.reduce((sum, move) => sum + move.ms, 0)
const SPINS_PER_LOOP = BOOT_MOVES.reduce((n, move) => n + move.beats.filter((b) => b.spin).length, 0)

/** Pose no instante `t` (ms desde o início da dança). `spins` só cresce: serve de `spinSignal`. */
export function bootPose(t: number): BootPose {
	const time = Math.max(0, t)
	let rest = time % LOOP_MS
	let spins = Math.floor(time / LOOP_MS) * SPINS_PER_LOOP
	for (const move of BOOT_MOVES) {
		if (rest >= move.ms) {
			rest -= move.ms
			spins += move.beats.filter((b) => b.spin).length
			continue
		}
		let expression = move.beats[0]?.expression ?? "neutral"
		for (const beat of move.beats) {
			if (beat.at > rest) break
			expression = beat.expression
			if (beat.spin) spins += 1
		}
		return { state: move.state, expression, spins }
	}
	return { state: "playful", expression: "happy", spins }
}

// --- sinal "o app carregou" -------------------------------------------------------------------
let appReady = false
const listeners = new Set<() => void>()

export function markAppReady() {
	if (appReady) return
	appReady = true
	for (const listener of listeners) listener()
}

export function isAppReady() {
	return appReady
}

export function subscribeAppReady(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Só para testes. */
export function resetAppReadyForTests() {
	appReady = false
	listeners.clear()
}
