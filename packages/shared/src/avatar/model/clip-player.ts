// ClipPlayer: toca um clipe de cada vez, com ponte suave (0,35 s) entre clipes
// e dispara os eventos do clipe (troca de expressão, piscada, fim). Puro: o
// tempo só anda por `advance`.
import {
	BRIDGE_EASE,
	BRIDGE_S,
	easeAt,
	getClip,
	lerpPose,
	poseAt,
	posesClose,
	restPose,
	startPose,
	type Pose,
	type RawClip,
} from "./clips.js";

export type ClipEvent =
	| { type: "expression"; name: string }
	| { type: "blink" }
	| { type: "end"; name: string };

type Pending = { name: string; clip: RawClip; phase: number };

export class ClipPlayer {
	private clip: RawClip | null = null;
	private clipName: string | null = null;
	private time = 0;
	private playing = false;
	private loopCount = 0;
	private bridge: { from: Pose; to: Pose; t: number; pending: Pending | null } | null = null;
	private current: Pose = restPose();
	private loadedDuringEnd = false;

	constructor(private readonly onEvent: (event: ClipEvent) => void = () => undefined) {}

	get pose(): Pose {
		return this.current;
	}

	get name(): string | null {
		return this.clipName;
	}

	get loops(): number {
		return this.loopCount;
	}

	get anchor(): number {
		return this.clip?.anchor ?? 0;
	}

	/** Parado de verdade: sem clipe tocando e sem ponte em andamento. */
	get isSettled(): boolean {
		return !this.playing && this.bridge === null;
	}

	/**
	 * Carrega um clipe. Com `bridge`, parte da pose atual até a pose inicial do
	 * clipe em 0,35 s (a menos que sejam quase iguais); `phase` (0..1) começa
	 * no meio do clipe (desincroniza avatares lado a lado).
	 */
	load(name: string, opts: { phase?: number; bridge?: boolean } = {}): void {
		const clip = getClip(name);
		const phase = opts.phase ?? 0;
		this.loadedDuringEnd = true;
		const target = startPose(clip);
		if ((opts.bridge ?? true) && this.hasPlayed && !posesClose(this.current, target)) {
			this.clip = null;
			this.clipName = name;
			this.playing = true;
			this.bridge = { from: this.current, to: target, t: 0, pending: { name, clip, phase } };
			return;
		}
		this.begin({ name, clip, phase });
	}

	/** Para o clipe e volta (com ponte) à pose de repouso. */
	rest(): void {
		this.clip = null;
		this.clipName = null;
		this.playing = false;
		const target = restPose();
		if (this.hasPlayed && !posesClose(this.current, target)) {
			this.bridge = { from: this.current, to: target, t: 0, pending: null };
		} else {
			this.bridge = null;
			this.current = target;
		}
	}

	private hasPlayed = false;

	private begin(p: Pending): void {
		this.hasPlayed = true;
		this.clip = p.clip;
		this.clipName = p.name;
		this.bridge = null;
		this.playing = true;
		this.time = p.phase * p.clip.duration;
		this.current = poseAt(p.clip, this.time);
		// Expressão do instante inicial: a última marcada até aqui, senão neutra.
		let name = "neutral";
		for (const [t, value] of p.clip.expr) {
			if (t > this.time + 1e-9) break;
			if (value !== "blink") name = value;
		}
		this.onEvent({ type: "expression", name });
	}

	advance(dt: number): void {
		if (!(dt > 0)) return;
		if (this.bridge) {
			this.advanceBridge(dt);
			return;
		}
		const clip = this.clip;
		if (!this.playing || !clip) return;
		const before = this.time;
		this.time += dt;
		const end = this.time >= clip.duration;
		const upTo = end ? clip.duration : this.time;
		for (const [t, value] of clip.expr) {
			if (t <= before || t > upTo) continue;
			this.onEvent(value === "blink" ? { type: "blink" } : { type: "expression", name: value });
		}
		if (!end) {
			this.current = poseAt(clip, this.time);
			return;
		}
		this.current = poseAt(clip, clip.duration);
		this.loopCount += 1;
		this.loadedDuringEnd = false;
		this.onEvent({ type: "end", name: this.clipName ?? "" });
		if (this.loadedDuringEnd) return; // o controlador escolheu o próximo clipe
		// Sem controlador: repete o mesmo clipe (com ponte se a ponta não fecha o ciclo).
		const again = { name: this.clipName ?? "", clip, phase: 0 };
		if (posesClose(this.current, startPose(clip))) this.begin(again);
		else this.bridge = { from: this.current, to: startPose(clip), t: 0, pending: again };
	}

	private advanceBridge(dt: number): void {
		const b = this.bridge;
		if (!b) return;
		b.t += dt;
		const u = Math.min(1, b.t / BRIDGE_S);
		this.current = lerpPose(b.from, b.to, easeAt(u, BRIDGE_EASE));
		if (u < 1) return;
		this.bridge = null;
		if (b.pending) {
			this.begin(b.pending);
			return;
		}
		this.current = b.to;
		this.playing = false;
	}
}
