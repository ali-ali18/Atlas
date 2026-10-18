import { expect, it } from "vitest";
import { createConnectorReadCache } from "./read-cache.js";
it("readOnly liga cache/TTL/refresh; escrita sempre executa e invalida", async () => {
	let now = 0,
		calls = 0;
	const cache = createConnectorReadCache(() => now, 30);
	const read = { connector: "a", tool: "get", args: { id: 1 }, readOnly: true };
	const call = async () => ({
		ok: true,
		text: String(++calls),
		truncated: false,
	});
	expect((await cache.run(read, call)).text).toBe("1");
	expect((await cache.run(read, call)).text).toBe("1");
	expect((await cache.run({ ...read, refresh: true }, call)).text).toBe("2");
	now = 31;
	expect((await cache.run(read, call)).text).toBe("3");
	await cache.run({ ...read, readOnly: false }, call);
	await cache.run({ ...read, readOnly: false }, call);
	expect((await cache.run(read, call)).text).toBe("6");
	expect((await createConnectorReadCache().run(read, call)).text).toBe("7");
});
it("single-flight e escrita durante leitura não repopula cache stale", async () => {
	const cache = createConnectorReadCache();
	const read = { connector: "a", tool: "get", args: {}, readOnly: true };
	let release!: () => void,
		calls = 0;
	const call = async () => {
		calls++;
		await new Promise<void>((r) => {
			release = r;
		});
		return { ok: true, text: "old", truncated: false };
	};
	const one = cache.run(read, call),
		two = cache.run(read, call);
	await cache.run({ ...read, readOnly: false }, async () => ({
		ok: true,
		text: "write",
		truncated: false,
	}));
	release();
	await Promise.all([one, two]);
	expect(calls).toBe(1);
	expect(
		(
			await cache.run(read, async () => ({
				ok: true,
				text: "fresh",
				truncated: false,
			}))
		).text,
	).toBe("fresh");
});
