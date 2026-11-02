import { describe, expect, it, vi } from "vitest";
import { createSaveGuard, saveBot } from "./bot-save";
import { ChatApiError } from "./chat-api";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => (resolve = res));
	return { promise, resolve };
};

describe("salvar o bot", () => {
	it("sucesso: PATCH e depois a atualização da home", async () => {
		const order: string[] = [];
		const result = await saveBot({ patchBot: async () => void order.push("patch"), applyUpdate: () => void order.push("apply") }, { name: "Novo" });
		expect(result).toEqual({ ok: true });
		expect(order).toEqual(["patch", "apply"]);
	});
	it("falha: não atualiza a home, devolve a frase e deixa tentar de novo", async () => {
		const applyUpdate = vi.fn();
		let attempt = 0;
		const patchBot = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) throw new ChatApiError("x", 500);
		});
		const first = await saveBot({ patchBot, applyUpdate }, { name: "Novo" });
		expect(first).toMatchObject({ ok: false, unauthorized: false });
		expect(applyUpdate).not.toHaveBeenCalled();
		expect(await saveBot({ patchBot, applyUpdate }, { name: "Novo" })).toEqual({ ok: true });
		expect(applyUpdate).toHaveBeenCalledTimes(1);
		expect(applyUpdate).toHaveBeenCalledWith({ name: "Novo" });
	});
	it("401 pede para sair da sessão", async () => {
		const result = await saveBot({ patchBot: async () => Promise.reject(new ChatApiError("x", 401)), applyUpdate: vi.fn() }, { name: "x" });
		expect(result).toMatchObject({ ok: false, unauthorized: true });
	});
});

describe("guarda de toque duplo", () => {
	it("dois toques seguidos fazem um PATCH só e um goBack só", async () => {
		const gate = deferred();
		const patchBot = vi.fn(() => gate.promise);
		const applyUpdate = vi.fn();
		const guard = createSaveGuard();
		const run = () => guard.run(() => saveBot({ patchBot, applyUpdate }, { name: "N" }));
		const first = run();
		const second = run(); // mesmo instante, antes de qualquer re-render
		expect(await second).toEqual({ ok: "ignored" });
		gate.resolve();
		expect(await first).toEqual({ ok: true });
		expect(patchBot).toHaveBeenCalledTimes(1);
		expect(applyUpdate).toHaveBeenCalledTimes(1);
	});
	it("depois de terminar (ou falhar) a guarda libera", async () => {
		const guard = createSaveGuard();
		const failing = await guard.run(() => saveBot({ patchBot: async () => Promise.reject(new ChatApiError("x", 500)), applyUpdate: vi.fn() }, { name: "a" }));
		expect(failing).toMatchObject({ ok: false });
		expect(guard.busy).toBe(false);
		expect(await guard.run(() => saveBot({ patchBot: async () => undefined, applyUpdate: vi.fn() }, { name: "a" }))).toEqual({ ok: true });
	});
});
