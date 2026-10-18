import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import type { FilePreview } from "@workspace/shared";
import { EXTRACT_LIMITS, type ExtractFailure, type ExtractInput, type ExtractOutcome, type ExtractedAttachment, type Extractor } from "./extract.js";

/**
 * Pool pequeno de worker threads para ler anexos (PDF, Office, planilha). O trabalho pesado nunca
 * roda no loop de eventos do worker: cada arquivo vai para uma thread com teto de memória
 * (`resourceLimits`) e prazo duro. Estourou o prazo ou a memória, a thread é morta com
 * `terminate()` (vale até em laço síncrono, ao contrário de abort cooperativo) e o resultado vira
 * uma nota para o modelo, sem derrubar o run. Threads ociosas são reaproveitadas e reciclam depois
 * de alguns arquivos (fragmentação de heap do pdf.js).
 */

export type ExtractPoolOptions = {
	/** Arquivo da thread. Padrão: `extract-thread.js` ao lado (ou `.ts` sob tsx). */
	entry?: string | URL;
	size?: number;
	/** Prazo duro por arquivo; passou disso a thread é morta. */
	timeoutMs?: number;
	resourceLimits?: ResourceLimits;
	/** Ociosa há tanto tempo, a thread encerra. */
	idleMs?: number;
	/** Recicla a thread depois deste número de trabalhos. */
	maxJobsPerThread?: number;
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 };

type Reply = { id: number; ok: true; extracted?: ExtractedAttachment; pageCount?: number | null; preview?: FilePreview } | { id: number; ok: false; error: string };
type Outcome = { reply: Reply } | { failure: ExtractFailure };
type Pending = { id: number; message: Record<string, unknown>; done: (outcome: Outcome) => void };
// O lib DOM do tsconfig base esconde os `on(...)` do Worker do Node; só o que o pool usa.
type Thread = { on(event: string, listener: (...args: any[]) => void): unknown; postMessage(value: unknown): void; terminate(): Promise<number>; unref(): void };
type Slot = { worker: Thread; job: Pending | null; timer: NodeJS.Timeout | null; idleTimer: NodeJS.Timeout | null; jobs: number; dead: boolean };

function defaultEntry(): string {
	const js = fileURLToPath(new URL("./extract-thread.js", import.meta.url));
	return existsSync(js) ? js : fileURLToPath(new URL("./extract-thread.ts", import.meta.url));
}

const FAILURE_NOTE: Record<ExtractFailure, (seconds: number) => string> = {
	timeout: (seconds) => `Could not read this file: reading it took longer than ${seconds}s and was stopped. Copy it with attachment_to_computer to process it with a tool there.`,
	memory: () => "Could not read this file: it needs more memory than reading is allowed to use and was stopped. Copy it with attachment_to_computer to process it with a tool there.",
	crash: () => "Could not read this file: the reader crashed on it (corrupt or unsupported). Copy it with attachment_to_computer to process it with a tool there.",
};

export function failedExtraction(kind: ExtractInput["kind"], failure: ExtractFailure, timeoutMs: number): ExtractedAttachment {
	return { kind, text: "", tables: [], textCut: false, notes: [FAILURE_NOTE[failure](Math.round(timeoutMs / 1000))] };
}

export class ExtractPool implements Extractor {
	private readonly entry: string | URL;
	private readonly size: number;
	private readonly timeoutMs: number;
	private readonly limits: ResourceLimits;
	private readonly idleMs: number;
	private readonly maxJobs: number;
	private readonly slots: Slot[] = [];
	private readonly queue: Pending[] = [];
	private nextId = 1;
	private closed = false;

	constructor(options: ExtractPoolOptions = {}) {
		this.entry = options.entry ?? defaultEntry();
		this.size = Math.max(1, options.size ?? 2);
		this.timeoutMs = options.timeoutMs ?? EXTRACT_LIMITS.timeoutMs;
		this.limits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
		this.idleMs = options.idleMs ?? 60_000;
		this.maxJobs = options.maxJobsPerThread ?? 25;
	}

	/** Threads vivas agora (teste/observabilidade). */
	get threads(): number {
		return this.slots.length;
	}

	async extract(input: ExtractInput): Promise<ExtractOutcome> {
		// Margem para a leitura cooperativa de dentro da thread terminar antes do kill.
		const inner = Math.max(1_000, this.timeoutMs - 3_000);
		const result = await this.run({ op: "extract", filename: input.filename, kind: input.kind, bytes: input.bytes, timeoutMs: inner });
		if ("failure" in result) return { extracted: failedExtraction(input.kind, result.failure, this.timeoutMs), failure: result.failure };
		if (result.reply.ok && result.reply.extracted) return { extracted: result.reply.extracted };
		return { extracted: failedExtraction(input.kind, "crash", this.timeoutMs), failure: "crash" };
	}

	async pageCount(bytes: Uint8Array): Promise<number | null> {
		const result = await this.run({ op: "pageCount", bytes });
		return "reply" in result && result.reply.ok && typeof result.reply.pageCount === "number" ? result.reply.pageCount : null;
	}

	/** Prévia (docx/xlsx...) gerada na thread, com os mesmos limites. `null` = não deu (corrompido, prazo, memória). */
	async preview(input: { id: string; filename: string; bytes: Uint8Array }): Promise<FilePreview | null> {
		const result = await this.run({ op: "preview", fileId: input.id, filename: input.filename, bytes: input.bytes });
		return "reply" in result && result.reply.ok && result.reply.preview ? result.reply.preview : null;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.queue.splice(0)) job.done({ failure: "crash" });
		await Promise.all(this.slots.slice().map((slot) => this.kill(slot, "crash")));
	}

	private run(message: Record<string, unknown>): Promise<Outcome> {
		if (this.closed) return Promise.resolve({ failure: "crash" });
		return new Promise((resolve) => {
			const id = this.nextId++;
			this.queue.push({ id, message: { ...message, id }, done: resolve });
			this.dispatch();
		});
	}

	private dispatch(): void {
		while (this.queue.length > 0) {
			const slot = this.slots.find((item) => !item.job && !item.dead) ?? (this.slots.length < this.size ? this.spawn() : null);
			if (!slot) return;
			this.assign(slot, this.queue.shift()!);
		}
	}

	private spawn(): Slot {
		const worker = new Worker(this.entry, { resourceLimits: this.limits }) as unknown as Thread;
		const slot: Slot = { worker, job: null, timer: null, idleTimer: null, jobs: 0, dead: false };
		worker.unref();
		worker.on("message", (reply: Reply) => {
			const job = slot.job;
			if (!job || job.id !== reply.id) return;
			this.finish(slot, { reply });
			if (slot.jobs >= this.maxJobs) void this.kill(slot, "crash");
			else this.armIdle(slot);
			this.dispatch();
		});
		worker.on("error", (error: Error & { code?: string }) => {
			void this.kill(slot, error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crash");
		});
		worker.on("exit", () => {
			void this.kill(slot, "crash");
		});
		this.slots.push(slot);
		return slot;
	}

	private assign(slot: Slot, job: Pending): void {
		if (slot.idleTimer) clearTimeout(slot.idleTimer);
		slot.idleTimer = null;
		slot.job = job;
		slot.jobs += 1;
		slot.timer = setTimeout(() => void this.kill(slot, "timeout"), this.timeoutMs);
		slot.timer.unref();
		try {
			slot.worker.postMessage(job.message);
		} catch {
			void this.kill(slot, "crash");
		}
	}

	private finish(slot: Slot, outcome: Outcome): void {
		const job = slot.job;
		slot.job = null;
		if (slot.timer) clearTimeout(slot.timer);
		slot.timer = null;
		job?.done(outcome);
	}

	private armIdle(slot: Slot): void {
		if (slot.idleTimer) clearTimeout(slot.idleTimer);
		slot.idleTimer = setTimeout(() => void this.kill(slot, "crash"), this.idleMs);
		slot.idleTimer.unref();
	}

	/** Encerra a thread de verdade; o trabalho em curso (se houver) falha com o motivo. */
	private async kill(slot: Slot, failure: ExtractFailure): Promise<void> {
		if (slot.dead) return;
		slot.dead = true;
		if (slot.idleTimer) clearTimeout(slot.idleTimer);
		const index = this.slots.indexOf(slot);
		if (index >= 0) this.slots.splice(index, 1);
		this.finish(slot, { failure });
		await slot.worker.terminate().catch(() => undefined);
		if (!this.closed) this.dispatch();
	}
}

let shared: ExtractPool | null = null;

/** Pool único do processo (worker). Nasce na primeira leitura; threads encerram sozinhas quando ociosas. */
export function sharedExtractor(): Extractor {
	return sharedPool();
}

function sharedPool(): ExtractPool {
	shared ??= new ExtractPool();
	return shared;
}

/** Prévia de arquivo fora do loop de eventos (usada pela API). */
export function previewInThread(input: { id: string; filename: string; bytes: Uint8Array }): Promise<FilePreview | null> {
	return sharedPool().preview(input);
}

export async function shutdownSharedExtractor(): Promise<void> {
	const pool = shared;
	shared = null;
	await pool?.close();
}
