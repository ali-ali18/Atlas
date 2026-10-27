import { describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { loadSandboxConfig } from "./config.js";
import {
	loadMemoryGuardLimits,
	MIN_IDLE_FOR_MEMORY_STOP_MS,
	pickVmsToStop,
	readAvailableMemBytes,
	runMemoryGuard,
	type RunningVm,
} from "./memory-guard.js";

const MB = 1024 * 1024;
const MIN = 60_000;
const vm = (id: string, idleMs: number | null): RunningVm => ({ id, name: `atlas-sandbox-${id}`, userId: "u1", conversationId: `c-${id}`, idleMs });
const limits = { maxRunning: 3, minFreeBytes: 512 * MB };

describe("pickVmsToStop", () => {
	it("dentro dos limites não para nada", () => {
		expect(pickVmsToStop([vm("a", 60 * MIN), vm("b", 30 * MIN)], limits, 4096 * MB)).toEqual([]);
	});

	it("acima do máximo para o excedente, da mais parada para a menos (LRU)", () => {
		const vms = [vm("a", 10 * MIN), vm("b", 90 * MIN), vm("c", 30 * MIN), vm("d", 60 * MIN), vm("e", 5 * MIN)];
		expect(pickVmsToStop(vms, limits, 4096 * MB).map((v) => v.id)).toEqual(["b", "d"]);
	});

	it("pouca memória livre para uma VM ociosa mesmo abaixo do máximo", () => {
		const vms = [vm("a", 10 * MIN), vm("b", 40 * MIN)];
		expect(pickVmsToStop(vms, limits, 100 * MB).map((v) => v.id)).toEqual(["b"]);
	});

	it("nunca para VM em uso, recente ou de ociosidade desconhecida", () => {
		const vms = [vm("a", null), vm("b", MIN_IDLE_FOR_MEMORY_STOP_MS - 1), vm("c", 1_000), vm("d", 0)];
		expect(pickVmsToStop(vms, { maxRunning: 1, minFreeBytes: 512 * MB }, 10 * MB)).toEqual([]);
	});

	it("limite 0 desliga a checagem; memória desconhecida não dispara", () => {
		const vms = [vm("a", 60 * MIN), vm("b", 60 * MIN), vm("c", 60 * MIN), vm("d", 60 * MIN)];
		expect(pickVmsToStop(vms, { maxRunning: 0, minFreeBytes: 0 }, 1)).toEqual([]);
		expect(pickVmsToStop([vm("a", 60 * MIN)], limits, null)).toEqual([]);
	});
});

describe("limites e leitura de memória", () => {
	it("env inválido cai nos padrões; 0 desliga", () => {
		expect(loadMemoryGuardLimits({} as NodeJS.ProcessEnv)).toEqual({ maxRunning: 3, minFreeBytes: 512 * MB });
		expect(loadMemoryGuardLimits({ SANDBOX_MAX_RUNNING: "x", SANDBOX_MIN_FREE_MEM_MB: "-4" } as NodeJS.ProcessEnv)).toEqual({ maxRunning: 3, minFreeBytes: 512 * MB });
		expect(loadMemoryGuardLimits({ SANDBOX_MAX_RUNNING: "0", SANDBOX_MIN_FREE_MEM_MB: "0" } as NodeJS.ProcessEnv)).toEqual({ maxRunning: 0, minFreeBytes: 0 });
	});

	it("lê MemAvailable do /proc/meminfo", () => {
		expect(readAvailableMemBytes(() => "MemTotal: 8000000 kB\nMemAvailable:    2048 kB\n")).toBe(2048 * 1024);
	});
});

describe("runMemoryGuard", () => {
	const config = loadSandboxConfig({ SANDBOX_ENABLED: "true" } as NodeJS.ProcessEnv);
	function fakeDocker(ids: string[]) {
		const stopped: Array<{ id: string; opts: unknown }> = [];
		const docker = {
			listContainers: async () => ids.map((id) => ({ Id: id, Names: [`/atlas-sandbox-${id}`], Labels: { "atlas.sandbox.userId": "u1", "atlas.sandbox.conversationId": `c-${id}` } })),
			getContainer: (id: string) => ({ stop: async (opts: unknown) => void stopped.push({ id, opts }) }),
		} as unknown as Docker;
		return { docker, stopped };
	}

	it("para só a VM ociosa mais antiga (stop de 15 s) e avisa o dono DEPOIS de parar", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const order: string[] = [];
		const stopped: string[] = [];
		const docker = {
			listContainers: async () => ["a", "b", "c", "d"].map((id) => ({ Id: id, Names: [`/atlas-sandbox-${id}`], Labels: { "atlas.sandbox.userId": "u1", "atlas.sandbox.conversationId": `c-${id}` } })),
			getContainer: (id: string) => ({ stop: async (opts: unknown) => void (order.push(`stop:${id}`), stopped.push(JSON.stringify(opts))) }),
		} as unknown as Docker;
		const idle: Record<string, number> = { a: 5 * MIN, b: 50 * MIN, c: 20 * MIN, d: 0 };
		const result = await runMemoryGuard(docker, config, {
			limits,
			availableMemBytes: () => 4096 * MB,
			probe: async (_d, _c, id) => idle[id]!,
			onStopped: async (v) => void order.push(`notified:${v.id}`),
		});
		expect(result.map((v) => v.id)).toEqual(["b"]);
		expect(stopped).toEqual([JSON.stringify({ t: 15 })]);
		expect(order).toEqual(["stop:b", "notified:b"]);
	});

	it("stop que falha não avisa o dono e a rodada tenta a próxima candidata", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const notified: string[] = [];
		const stopped: string[] = [];
		const docker = {
			listContainers: async () => ["a", "b"].map((id) => ({ Id: id, Names: [`/atlas-sandbox-${id}`], Labels: { "atlas.sandbox.userId": "u1", "atlas.sandbox.conversationId": `c-${id}` } })),
			getContainer: (id: string) => ({
				stop: async () => {
					if (id === "b") throw new Error("docker fora");
					stopped.push(id);
				},
			}),
		} as unknown as Docker;
		const idle: Record<string, number> = { a: 20 * MIN, b: 50 * MIN };
		const result = await runMemoryGuard(docker, config, {
			limits,
			availableMemBytes: () => 10 * MB,
			probe: async (_d, _c, id) => idle[id]!,
			onStopped: async (v) => void notified.push(v.id),
		});
		expect(stopped).toEqual(["a"]);
		expect(notified).toEqual(["a"]);
		expect(result.map((v) => v.id)).toEqual(["a"]);
	});

	it("falha ao avisar depois de parar é só logada (a VM já parou)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { docker, stopped } = fakeDocker(["a"]);
		const result = await runMemoryGuard(docker, config, {
			limits,
			availableMemBytes: () => 10 * MB,
			probe: async () => 30 * MIN,
			onStopped: async () => {
				throw new Error("db fora");
			},
		});
		expect(stopped.map((s) => s.id)).toEqual(["a"]);
		expect(result.map((v) => v.id)).toEqual(["a"]);
		expect(err).toHaveBeenCalled();
	});

	it("nunca para VM protegida (run esperando o login do usuário), mesmo ociosa; erro na consulta protege", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const { docker, stopped } = fakeDocker(["a", "b", "c"]);
		const idle: Record<string, number> = { a: 90 * MIN, b: 40 * MIN, c: 30 * MIN };
		const result = await runMemoryGuard(docker, config, {
			limits: { maxRunning: 2, minFreeBytes: 0 },
			availableMemBytes: () => 4096 * MB,
			probe: async (_d, _c, id) => idle[id]!,
			isProtected: async (v) => {
				if (v.id === "a") return true;
				if (v.id === "b") throw new Error("db fora");
				return false;
			},
		});
		expect(result.map((v) => v.id)).toEqual(["c"]);
		expect(stopped.map((s) => s.id)).toEqual(["c"]);
	});
});
