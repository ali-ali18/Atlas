import type { ComputerUseEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { applyLiveEvent, createLiveBubbleState, hydrateRunEvents, trackSupersededBubbles, type LiveBubbleState } from "./thread-live";
import { dedupeCards } from "./thread-merge";
import { applyServerTail } from "./thread-sync";

/**
 * Simulador do chat para os testes de convergência: um "servidor" que só acrescenta linhas (como o banco)
 * e um "cliente" que aplica, na ordem que o teste escolher, os mesmos passos puros do hook
 * (mensagem otimista, deltas ao vivo, cartões, busca do fim da conversa, recarga).
 */

export type PersistSplit = "none" | "paragraph" | "line";

export class SimServer {
	rows: Message[] = [];
	/** Cada gravação gera uma "foto" do banco: uma réplica atrasada devolve uma foto antiga. */
	snapshots: Message[][] = [[]];
	private n = 0;
	private add(message: { kind: string; id?: string; [key: string]: unknown }): Message {
		const row = { ...message, id: message.id ?? `db-${++this.n}` } as unknown as Message;
		this.rows = [...this.rows, row];
		this.snapshots.push(this.rows);
		return row;
	}
	user(text: string): Message {
		return this.add({ kind: "user", text });
	}
	/** Fala intermediária (texto de um passo seguido de tools) ou final: uma linha por parágrafo/linha, como o worker. */
	assistant(text: string, split: PersistSplit = "none"): Message[] {
		const parts = split === "none" ? [text] : text.split(split === "paragraph" ? /\n{2,}/ : /\n/).filter((part) => part.trim());
		return parts.map((part) => this.add({ kind: "assistant", text: part }));
	}
	tool(label: string, text: string): Message {
		return this.add({ kind: "tool", label, text });
	}
	card(message: Message): Message {
		return this.add(message);
	}
	get head(): Message[] {
		return this.rows;
	}
	/** Foto da versão `index` (clampada): réplica atrasada. */
	stale(index: number): Message[] {
		return this.snapshots[Math.max(0, Math.min(index, this.snapshots.length - 1))]!;
	}
}

export class SimClient {
	screen: Message[] = [];
	private optimistic = 0;
	/** Passos cujo texto o servidor já cobriu (como o hook guarda por run). */
	private live: LiveBubbleState = createLiveBubbleState();
	constructor(initial: Message[] = []) {
		this.screen = initial;
	}
	/** Clique em enviar: bolha otimista do usuário (`msg-*`). */
	send(text: string): string {
		const id = `msg-${++this.optimistic}`;
		this.screen = [...this.screen, { id, kind: "user", text }];
		return id;
	}
	delta(step: string, delta: string) {
		this.screen = applyLiveEvent(this.screen, { type: "assistant_delta", id: step, delta }, this.live);
	}
	discard() {
		this.screen = applyLiveEvent(this.screen, { type: "assistant_discard" }, this.live);
	}
	/** Cartão que chega ao vivo (confirmação, etc.). */
	liveCard(message: Message) {
		this.screen = dedupeCards([...this.screen, message]);
	}
	/** Busca do fim da conversa (hub, resync, fim do run, volta do segundo plano). */
	fetch(tail: Message[], options: { runLive: boolean; resultText?: string | null }) {
		this.screen = trackSupersededBubbles(this.screen, applyServerTail(this.screen, tail, options), this.live);
	}
	/** Abriu a conversa do zero (F5, link de notificação). */
	reload(thread: Message[]) {
		this.live = createLiveBubbleState();
		this.screen = thread;
	}
	/** Recarrega e reaplica os eventos do run vivo. */
	reloadMidRun(thread: Message[], events: ComputerUseEvent[]) {
		this.live = createLiveBubbleState();
		this.screen = hydrateRunEvents(thread, events, this.live);
	}
	get ids(): string[] {
		return this.screen.map((m) => m.id);
	}
	/** Resumo legível: "user:oi", "assistant:texto". */
	get summary(): string[] {
		return this.screen.map((m) => `${m.kind}:${"text" in m ? m.text : m.kind === "confirm" ? m.title : m.id}`);
	}
}

export function summarize(messages: Message[]): string[] {
	return new SimClient(messages).summary;
}

/** PRNG determinístico (mulberry32) para os testes embaralhados. */
export function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle<T>(items: T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}
