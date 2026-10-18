import { expect, it } from "vitest";
import {
	createReadCache,
	stableReadKey,
	scheduleIndependentReads,
} from "./read-execution.js";
it("cache tem TTL, referência acessível e invalidação por conector", async () => {
	let now = 0;
	const cache = createReadCache("run-a", () => now, 30);
	const key = stableReadKey("get", { b: 2, a: 1 });
	expect(key).toBe(stableReadKey("get", { a: 1, b: 2 }));
	cache.remember(key, "conn", "run-a:0:call:get", "payload");
	expect(cache.get(key)?.ref).toBe("run-a:0:call:get");
	expect(await cache.resolve("run-a:0:call:get")).toBe("payload");
	await expect(cache.resolve("run-b:0:call:get")).rejects.toThrow();
	cache.invalidate("conn");
	expect(cache.get(key)).toBeNull();
	cache.remember(key, "conn", "run-a:ref", "payload");
	now = 31;
	expect(cache.get(key)).toBeNull();
	expect(
		await cache.resolve("run-a:durable", async () => ({
			ok: true,
			summary: "persisted",
		})),
	).toBe("persisted");
});
it("três leituras independentes em paralelo; escrita e duplicata são barreiras", async () => {
	let active = 0,
		maximum = 0;
	const seen: string[] = [];
	await scheduleIndependentReads(
		["a", "b", "c", "write", "a", "a"],
		(id) => (id === "write" ? null : id),
		async (id) => {
			active++;
			maximum = Math.max(maximum, active);
			if (id === "write") expect(active).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 1));
			seen.push(id);
			active--;
		},
	);
	expect(maximum).toBe(3);
	expect(seen.slice(0, 3).sort()).toEqual(["a", "b", "c"]);
	expect(seen[3]).toBe("write");
});
it("falha espera outras leituras concluírem antes da barreira", async () => {
	let finished = false;
	await expect(
		scheduleIndependentReads(
			[1, 2, 3],
			(id) => (id === 3 ? null : String(id)),
			async (id) => {
				if (id === 1) throw new Error("crash");
				if (id === 2) {
					await new Promise((r) => setTimeout(r, 1));
					finished = true;
				}
				if (id === 3) throw new Error("barreira não deve executar");
			},
		),
	).rejects.toThrow("crash");
	expect(finished).toBe(true);
});

it("N6: nenhuma tool nova para carregar não é descoberta vazia", async () => {
	const { countEmptySearches } = await import("./read-execution.js");
	const search = {
		role: "assistant" as const,
		content: null,
		tool_calls: [
			{
				id: "search",
				type: "function" as const,
				function: { name: "mcp_tool_search", arguments: "{}" },
			},
		],
	};
	expect(
		countEmptySearches([
			search,
			{
				role: "tool",
				tool_call_id: "search",
				content: "Nenhuma tool nova para carregar (já ativas).",
			},
		]),
	).toBe(0);
});
