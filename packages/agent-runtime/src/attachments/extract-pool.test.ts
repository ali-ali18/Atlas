import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createExtractCache, type AttachmentRef, type ExtractStore } from "./context.js";
import { ExtractPool } from "./extract-pool.js";
import type { ExtractedAttachment, Extractor } from "./extract.js";

const entry = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const input = { filename: "a.pdf", kind: "pdf" as const, bytes: new Uint8Array([1, 2, 3]) };
const pools: ExtractPool[] = [];
const make = (name: string, options: ConstructorParameters<typeof ExtractPool>[0] = {}) => {
	const pool = new ExtractPool({ entry: entry(name), ...options });
	pools.push(pool);
	return pool;
};
afterEach(async () => { await Promise.all(pools.splice(0).map((pool) => pool.close())); });

describe("pool de extração", () => {
	it("mata de verdade a thread que trava num laço síncrono e devolve nota, sem travar quem chamou", async () => {
		const pool = make("thread-hang.mjs", { timeoutMs: 400 });
		const startedAt = Date.now();
		// O loop de eventos continua livre enquanto a thread trava.
		let ticks = 0;
		const timer = setInterval(() => { ticks += 1; }, 20);
		const out = await pool.extract(input);
		clearInterval(timer);
		expect(out.failure).toBe("timeout");
		expect(out.extracted.notes.join(" ")).toMatch(/took longer than/);
		expect(Date.now() - startedAt).toBeLessThan(3_000);
		expect(ticks).toBeGreaterThan(5);
		expect(pool.threads).toBe(0);
	});

	it("estouro de memória vira nota e a thread é descartada", async () => {
		const pool = make("thread-memory.mjs", { timeoutMs: 20_000, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
		const out = await pool.extract(input);
		expect(out.failure).toBe("memory");
		expect(out.extracted.notes.join(" ")).toMatch(/more memory/);
		expect(pool.threads).toBe(0);
	});

	it("depois de um kill o pool volta a funcionar com thread nova", async () => {
		const pool = make("thread-hang.mjs", { timeoutMs: 300 });
		expect((await pool.extract(input)).failure).toBe("timeout");
		expect(await pool.pageCount(input.bytes)).toBe(3);
	});

	it("reaproveita a mesma thread e respeita o tamanho do pool", async () => {
		const pool = make("thread-echo.mjs", { size: 1 });
		const [a, b] = await Promise.all([pool.extract(input), pool.extract(input)]);
		expect(a.extracted.text).toBe(b.extracted.text);
		expect(pool.threads).toBe(1);
		expect((await pool.extract(input)).extracted.text).toBe(a.extracted.text);
	});

	it("recicla a thread depois de N trabalhos", async () => {
		const pool = make("thread-echo.mjs", { size: 1, maxJobsPerThread: 2 });
		const first = (await pool.extract(input)).extracted.text;
		await pool.extract(input);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await pool.extract(input)).extracted.text).not.toBe(first);
	});

	it("depois de fechado, nada roda e nada trava", async () => {
		const pool = make("thread-echo.mjs");
		await pool.close();
		expect((await pool.extract(input)).failure).toBe("crash");
	});
});

describe("cache da extração", () => {
	const ref: AttachmentRef = { id: "f1", filename: "a.pdf", mime: "application/pdf", size: 3, kind: "pdf" };
	const extracted: ExtractedAttachment = { kind: "pdf", text: "texto", tables: [], textCut: false, notes: [], pageCount: 2 };

	function counting() {
		let extractions = 0;
		let loads = 0;
		const extractor: Extractor = {
			extract: async () => { extractions += 1; return { extracted }; },
			pageCount: async () => 2,
		};
		return { extractor, load: async () => { loads += 1; return new Uint8Array([1, 2, 3]); }, counts: () => ({ extractions, loads }) };
	}
	function memoryStore() {
		const disk = new Map<string, ExtractedAttachment>();
		const store: ExtractStore = { read: async (item) => disk.get(item.id) ?? null, write: async (item, value) => { disk.set(item.id, value); } };
		return { store, disk };
	}

	it("extrai uma vez e reaproveita o resultado gravado em outro run, sem reler o arquivo", async () => {
		const first = counting();
		const { store, disk } = memoryStore();
		await createExtractCache(first.load, { extractor: first.extractor, store }).get(ref);
		expect(first.counts()).toEqual({ extractions: 1, loads: 1 });
		expect(disk.get("f1")?.text).toBe("texto");

		const second = counting();
		const loaded = await createExtractCache(second.load, { extractor: second.extractor, store }).get(ref);
		expect(loaded?.extracted.text).toBe("texto");
		expect(second.counts()).toEqual({ extractions: 0, loads: 0 });
		await loaded?.bytes();
		expect(second.counts().loads).toBe(1);
	});

	it("arquivo morto por prazo ou memória não é gravado no cache em disco", async () => {
		const { store, disk } = memoryStore();
		const extractor: Extractor = { extract: async () => ({ extracted: { ...extracted, text: "" }, failure: "timeout" }), pageCount: async () => null };
		await createExtractCache(async () => new Uint8Array([1]), { extractor, store }).get(ref);
		expect(disk.size).toBe(0);
	});

	it("página do PDF vem do cache em disco quando já extraído", async () => {
		const run = counting();
		const { store } = memoryStore();
		await store.write(ref, extracted);
		expect(await createExtractCache(run.load, { extractor: run.extractor, store }).pageCount(ref)).toBe(2);
		expect(run.counts().loads).toBe(0);
	});
});
