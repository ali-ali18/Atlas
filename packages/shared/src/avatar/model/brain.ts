// Cérebro do avatar: uma rede recorrente pequena e FIXA (sem treino) que dá ao
// personagem um movimento contínuo e nunca idêntico enquanto o bot trabalha. Os
// clipes continuam mandando; o cérebro soma por cima deslocamentos pequenos
// (giro da cabeça, olhar, respiração, piscadas), com um peso que sobe quando o bot
// trabalha e some quando ele para.
//
// Como funciona: 20 nós "leaky" (integradores com vazamento, tanh) com pesos
// sorteados da semente do bot (dois bots, dois "temperamentos"; mesma semente,
// mesma sequência). A rede fica perto da borda do caos (ganho 1,5): nunca repete e
// nunca estoura (tanh limita). Entradas: a família de atividade (lendo, programando…
// misturada suavemente), pulsos de evento (ferramenta começou/terminou/falhou, rajada
// de texto) e o tempo desde o último evento. Cada família ainda tem um perfil (andamento,
// viés e amplitude por saída): é ele que faz "Lendo" e "Programando" parecerem diferentes;
// a rede só tira o movimento do padrão. Tudo é limitado por `BRAIN_LIMITS`.
//
// Puro: o tempo anda por `advance(dt)` em passos fixos de 1/60 s, então o resultado não
// depende do tamanho do quadro. Sem relógio, sem DOM.
import { clamp, lerp, rng } from "../geometry/math.js";
import type { AvatarState } from "./states.js";

export type ActivityFamily =
	| "idle"
	| "think"
	| "search"
	| "read"
	| "code"
	| "run"
	| "control"
	| "write"
	| "wait"
	| "work";

export const ACTIVITY_FAMILIES: readonly ActivityFamily[] = [
	"idle",
	"think",
	"search",
	"read",
	"code",
	"run",
	"control",
	"write",
	"wait",
	"work",
];

export type PulseKind = "toolStart" | "toolOk" | "toolFail" | "tokens";
const PULSES: readonly PulseKind[] = ["toolStart", "toolOk", "toolFail", "tokens"];

/** Família de atividade de um estado do avatar (o que o cérebro "sente"). */
export function familyOfState(state: AvatarState): ActivityFamily {
	switch (state) {
		case "thinking":
			return "think";
		case "searching":
		case "radar":
			return "search";
		case "reading":
			return "read";
		case "coding":
			return "code";
		case "running":
		case "computing":
			return "run";
		case "controlling":
			return "control";
		case "streaming":
		case "writing":
		case "dictating":
			return "write";
		case "waiting":
		case "orbit":
			return "wait";
		case "working":
		case "progress":
		case "loading":
		case "curious":
		case "spawning":
		case "sending":
		case "receiving":
		case "uploading":
			return "work";
		default:
			return "idle";
	}
}

/** Saída do cérebro: deslocamentos somados ao clipe. Já multiplicada pelo peso (0 = sem efeito). */
export type BrainOutput = {
	/** Graus. */
	yaw: number;
	pitch: number;
	roll: number;
	/** Olhar extra dos olhos, -1..1 (y para baixo). */
	gazeX: number;
	gazeY: number;
	/** > 0 achata (mais largo, mais baixo); < 0 estica. Fração. */
	squash: number;
	/** Respiração extra: fração do zoom. */
	breath: number;
	/** Multiplicador da taxa de piscadas (1 = normal). */
	blinkRate: number;
	/** Peso atual do cérebro, 0..1. */
	weight: number;
};

/** Teto de cada saída: mesmo num caso extremo, o movimento extra é pequeno ("vivo", não tremido). */
export const BRAIN_LIMITS = {
	yaw: 7,
	pitch: 6,
	roll: 4,
	gaze: 1,
	squash: 0.06,
	breath: 0.04,
	blinkMin: 0.4,
	blinkMax: 2,
} as const;

export const BRAIN_TUNING = {
	nodes: 20,
	/** Ganho dos pesos recorrentes (> 1: perto do caos, nunca periódico). */
	gain: 2.2,
	/** Peso das entradas dos marcapassos (desvio padrão). */
	pacemakerGain: 0.9,
	stepS: 1 / 60,
	maxStepsPerAdvance: 8,
	/** Constante de tempo (s) da subida e da descida do peso. */
	riseS: 0.8,
	fallS: 1.1,
	/** Constante de tempo (s) da troca de perfil entre famílias. */
	profileS: 0.6,
	/** Meia-vida dos pulsos (s). */
	pulseS: 0.35,
	/** Abaixo disto o peso vira 0 e o cérebro dorme. */
	sleepEps: 0.002,
} as const;
const T = BRAIN_TUNING;

// Saídas da rede, na ordem das colunas de AMP/BIAS: yaw, pitch, roll, gazeX, gazeY, squash, breath.
type Profile = {
	amp: readonly [number, number, number, number, number, number, number];
	bias: readonly [number, number, number, number, number, number, number];
	/** Andamento da rede (multiplica a velocidade dos nós). */
	tempo: number;
	/** Multiplicador da taxa de piscadas. */
	blink: number;
	/** 0..1: quanto o cérebro entra nessa família. */
	level: number;
};

const PROFILES: Record<ActivityFamily, Profile> = {
	idle: { amp: [0, 0, 0, 0, 0, 0, 0], bias: [0, 0, 0, 0, 0, 0, 0], tempo: 0.6, blink: 1, level: 0 },
	// olha para cima e inclina a cabeça: "pensando", lento
	think: { amp: [3, 2.5, 3, 0.5, 0.4, 0.01, 0.012], bias: [0, -1.5, 1.8, 0, -0.3, 0, 0], tempo: 0.7, blink: 0.8, level: 0.85 },
	// varre os lados rápido, olhos bem abertos
	search: { amp: [7, 2, 1, 1, 0.3, 0.012, 0.01], bias: [0, 0, 0, 0, 0, 0, 0], tempo: 1, blink: 1.3, level: 1 },
	// cabeça levemente baixa e varredura lenta e larga dos olhos, como linhas de texto
	read: { amp: [3.5, 1, 0.8, 0.95, 0.12, 0.006, 0.01], bias: [0, 1.2, 0, 0, 0.3, 0, 0], tempo: 0.5, blink: 0.7, level: 1 },
	// cabeça baixa, olhar fixo na tela, tremor curto e rápido, "toques" de teclado
	code: { amp: [1, 1.6, 1.5, 0.3, 0.12, 0.024, 0.008], bias: [0, 4, 0, 0, 0.5, 0, 0], tempo: 2.4, blink: 0.5, level: 1 },
	// respira mais fundo, balanço sutil: "processando"
	run: { amp: [1.4, 1.2, 1, 0.3, 0.2, 0.03, 0.03], bias: [0, 1, 0, 0, 0.1, 0, 0.01], tempo: 1, blink: 0.9, level: 1 },
	// movimentos de cabeça e olhos rápidos e curtos: "mexendo na tela"
	control: { amp: [3, 3, 3, 0.7, 0.8, 0.03, 0.008], bias: [0, 0, 0, 0, 0, 0, 0], tempo: 2.2, blink: 1.1, level: 1 },
	// acena de leve no ritmo do texto
	write: { amp: [2, 2.2, 1.2, 0.4, 0.2, 0.025, 0.015], bias: [0, 1.5, 0, 0, 0.15, 0, 0], tempo: 1.2, blink: 1, level: 1 },
	// quase parado, respira devagar
	wait: { amp: [1, 0.8, 1, 0.2, 0.15, 0.005, 0.02], bias: [0, 0, 0, 0, 0, 0, 0], tempo: 0.4, blink: 1, level: 0.7 },
	work: { amp: [3, 2, 1.5, 0.6, 0.3, 0.015, 0.012], bias: [0, 0, 0, 0, 0, 0, 0], tempo: 1, blink: 1, level: 1 },
};

/** Efeito direto de cada pulso nas 7 saídas (decai em `pulseS`); a rede também o recebe como entrada. */
const KICKS: Record<PulseKind, readonly [number, number, number, number, number, number, number]> = {
	toolStart: [0, -1.6, 0, 0, -0.25, 0.03, 0],
	toolOk: [0, 1.4, 0, 0, 0.2, -0.02, 0.004],
	// balançar a cabeça: o yaw oscila (abaixo) e o corpo se encolhe
	toolFail: [3.2, 0.6, 2.4, 0, 0, 0.035, 0],
	tokens: [0, 0.9, 0, 0, 0.1, 0.012, 0],
};

const OUTPUTS = 7;
/** Marcapassos: 4 senoides de períodos sem relação (7,1 · 4,3 · 2,9 · 1,7 s). Mantêm a rede se mexendo mesmo se o caos amortecer. */
const PACEMAKER_HZ = [0.14, 0.23, 0.34, 0.59] as const;
const PACEMAKERS = PACEMAKER_HZ.length;
const INPUTS = ACTIVITY_FAMILIES.length + PULSES.length + 1 + PACEMAKERS;

/** Número aproximadamente normal (soma de uniformes), de média 0 e desvio ~1. */
function gaussish(random: () => number): number {
	return (random() + random() + random() + random() - 2) * 1.732;
}

export class Brain {
	private readonly x = new Float64Array(T.nodes);
	private readonly next = new Float64Array(T.nodes);
	private readonly w: Float64Array;
	private readonly win: Float64Array;
	private readonly wout: Float64Array;
	private readonly bias: Float64Array;
	private readonly tauBase: Float64Array;
	private readonly u = new Float64Array(INPUTS);
	private readonly phase = new Float64Array(PACEMAKERS);
	private readonly mixFamily = new Float64Array(ACTIVITY_FAMILIES.length);
	private readonly pulse_ = new Float64Array(PULSES.length);
	private readonly cur = { amp: new Float64Array(OUTPUTS), bias: new Float64Array(OUTPUTS), tempo: 0.6, blink: 1, level: 0 };

	private family: ActivityFamily = "idle";
	private weight = 0;
	private sinceEvent = 30;
	private accumulator = 0;
	private clock = 0;
	private enabled = true;
	private readonly raw = new Float64Array(OUTPUTS);
	private readonly out = new Float64Array(OUTPUTS);

	readonly output: BrainOutput = {
		yaw: 0,
		pitch: 0,
		roll: 0,
		gazeX: 0,
		gazeY: 0,
		squash: 0,
		breath: 0,
		blinkRate: 1,
		weight: 0,
	};

	constructor(seed: number) {
		const random = rng(seed);
		const n = T.nodes;
		const scale = T.gain / Math.sqrt(n);
		this.w = new Float64Array(n * n);
		for (let i = 0; i < n * n; i++) this.w[i] = gaussish(random) * scale;
		this.win = new Float64Array(n * INPUTS);
		const pacemakerFrom = INPUTS - PACEMAKERS;
		for (let i = 0; i < n * INPUTS; i++) this.win[i] = gaussish(random) * (i % INPUTS >= pacemakerFrom ? T.pacemakerGain : 0.25);
		for (let k = 0; k < PACEMAKERS; k++) this.phase[k] = random() * Math.PI * 2;
		this.wout = new Float64Array(OUTPUTS * n);
		for (let i = 0; i < OUTPUTS * n; i++) this.wout[i] = gaussish(random) * (1.6 / Math.sqrt(n));
		this.bias = new Float64Array(n);
		this.tauBase = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			this.bias[i] = (random() - 0.5) * 0.1;
			this.tauBase[i] = 0.25 + random() * 1.75;
			this.x[i] = (random() - 0.5) * 0.8;
		}
		const idle = PROFILES.idle;
		this.cur.amp.set(idle.amp);
		this.cur.bias.set(idle.bias);
		this.mixFamily[0] = 1;
	}

	/** Liga/desliga (avatar pequeno não tem cérebro). Desligado, a saída vai a zero. */
	setEnabled(on: boolean): void {
		if (on === this.enabled) return;
		this.enabled = on;
		if (!on) this.reset();
	}

	get currentFamily(): ActivityFamily {
		return this.family;
	}

	setFamily(family: ActivityFamily): void {
		this.family = family;
	}

	/** Evento pontual: entra na rede e dá um pequeno gesto direto. `strength` 0..1. */
	pulse(kind: PulseKind, strength = 1): void {
		if (!this.enabled) return;
		const i = PULSES.indexOf(kind);
		if (i < 0) return;
		this.pulse_[i] = clamp((this.pulse_[i] as number) + clamp(strength, 0, 1), 0, 1.5);
		this.sinceEvent = 0;
	}

	/** O cérebro tem algo a animar (o loop não pode dormir). */
	get isActive(): boolean {
		if (!this.enabled) return false;
		return this.family !== "idle" || this.weight > T.sleepEps || this.hasPulse();
	}

	private hasPulse(): boolean {
		for (let i = 0; i < this.pulse_.length; i++) if ((this.pulse_[i] as number) > 0.004) return true;
		return false;
	}

	private reset(): void {
		this.weight = 0;
		this.pulse_.fill(0);
		this.write(0);
	}

	/** Anda `dt` segundos em passos fixos; o que sobra fica para a próxima chamada. */
	advance(dt: number): void {
		if (!this.enabled || !(dt > 0)) return;
		const wantsOn = this.family !== "idle" || this.hasPulse();
		if (!wantsOn && this.weight <= T.sleepEps) {
			// Dormindo: nada a calcular (a rede congela e retoma de onde parou); a saída fica em zero exato.
			this.reset();
			return;
		}
		this.accumulator += dt;
		let steps = 0;
		while (this.accumulator >= T.stepS && steps < T.maxStepsPerAdvance) {
			this.accumulator -= T.stepS;
			this.step(T.stepS);
			steps += 1;
		}
		if (steps === T.maxStepsPerAdvance) this.accumulator = 0;
		if (!wantsOn && this.weight <= T.sleepEps) this.reset();
		else this.write(this.weight);
	}

	private step(h: number): void {
		const n = T.nodes;
		this.clock += h;
		this.sinceEvent += h;
		const target = PROFILES[this.family];

		// peso: sobe devagar quando trabalha, desce mais devagar ainda ao parar
		const goal = target.level;
		const tau = goal > this.weight ? T.riseS : T.fallS;
		this.weight += (goal - this.weight) * (1 - Math.exp(-h / tau));
		if (goal === 0 && this.weight < T.sleepEps) this.weight = 0;

		// perfil e mistura de famílias seguem o alvo suavemente (sem salto ao trocar de família)
		const k = 1 - Math.exp(-h / T.profileS);
		for (let o = 0; o < OUTPUTS; o++) {
			this.cur.amp[o] = lerp(this.cur.amp[o] as number, target.amp[o] as number, k);
			this.cur.bias[o] = lerp(this.cur.bias[o] as number, target.bias[o] as number, k);
		}
		this.cur.tempo = lerp(this.cur.tempo, target.tempo, k);
		this.cur.blink = lerp(this.cur.blink, target.blink, k);
		const families = ACTIVITY_FAMILIES.length;
		for (let f = 0; f < families; f++) {
			const want = ACTIVITY_FAMILIES[f] === this.family ? 1 : 0;
			this.mixFamily[f] = lerp(this.mixFamily[f] as number, want, k);
		}

		// pulsos decaem
		const decay = Math.exp(-h / T.pulseS);
		for (let i = 0; i < this.pulse_.length; i++) this.pulse_[i] = (this.pulse_[i] as number) * decay;

		// entradas
		for (let f = 0; f < families; f++) this.u[f] = this.mixFamily[f] as number;
		for (let i = 0; i < PULSES.length; i++) this.u[families + i] = this.pulse_[i] as number;
		this.u[INPUTS - PACEMAKERS - 1] = Math.tanh(this.sinceEvent / 10);
		for (let k = 0; k < PACEMAKERS; k++) {
			this.phase[k] = (this.phase[k] as number) + Math.PI * 2 * (PACEMAKER_HZ[k] as number) * this.cur.tempo * h;
			this.u[INPUTS - PACEMAKERS + k] = Math.sin(this.phase[k] as number);
		}

		// rede: x += h/tau · (−x + tanh(W x + Win u + b))
		const speed = this.cur.tempo;
		for (let i = 0; i < n; i++) {
			let sum = this.bias[i] as number;
			const row = i * n;
			for (let j = 0; j < n; j++) sum += (this.w[row + j] as number) * (this.x[j] as number);
			const inRow = i * INPUTS;
			for (let j = 0; j < INPUTS; j++) sum += (this.win[inRow + j] as number) * (this.u[j] as number);
			const rate = Math.min(1, (h * speed) / (this.tauBase[i] as number));
			this.next[i] = (this.x[i] as number) + rate * (Math.tanh(sum) - (this.x[i] as number));
		}
		this.x.set(this.next);
	}

	/** Lê a rede, soma viés e pulsos, aplica o peso e os tetos. */
	private write(weight: number): void {
		const o = this.output;
		if (weight === 0 && !this.hasPulse()) {
			o.yaw = o.pitch = o.roll = o.gazeX = o.gazeY = o.squash = o.breath = 0;
			o.blinkRate = 1;
			o.weight = 0;
			return;
		}
		const n = T.nodes;
		const { raw, out } = this;
		for (let k = 0; k < OUTPUTS; k++) {
			let sum = 0;
			const row = k * n;
			for (let j = 0; j < n; j++) sum += (this.wout[row + j] as number) * (this.x[j] as number);
			raw[k] = Math.tanh(sum * 1.1) * (this.cur.amp[k] as number) + (this.cur.bias[k] as number);
		}
		// o 8º eixo da rede modula a taxa de piscadas, sem custo de outro readout
		const blinkWobble = Math.tanh((this.x[0] as number) - (this.x[1] as number));
		const p = this.pulse_;
		const shake = Math.sin(this.clock * 38) * (p[2] as number);
		for (let k = 0; k < OUTPUTS; k++) {
			let kick = 0;
			for (let c = 0; c < PULSES.length; c++) kick += (KICKS[PULSES[c] as PulseKind][k] as number) * (p[c] as number);
			out[k] = (raw[k] as number) * weight + kick;
		}
		out[0] = (out[0] as number) + shake * 2.2;
		const L = BRAIN_LIMITS;
		o.yaw = clamp(out[0] as number, -L.yaw, L.yaw);
		o.pitch = clamp(out[1] as number, -L.pitch, L.pitch);
		o.roll = clamp(out[2] as number, -L.roll, L.roll);
		o.gazeX = clamp(out[3] as number, -L.gaze, L.gaze);
		o.gazeY = clamp(out[4] as number, -L.gaze, L.gaze);
		o.squash = clamp(out[5] as number, -L.squash, L.squash);
		o.breath = clamp(out[6] as number, -L.breath, L.breath);
		const rate = 1 + (this.cur.blink - 1) * weight + blinkWobble * 0.15 * weight;
		o.blinkRate = clamp(rate, L.blinkMin, L.blinkMax);
		o.weight = weight;
	}
}
