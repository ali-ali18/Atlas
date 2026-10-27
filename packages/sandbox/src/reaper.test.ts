import { describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { loadSandboxConfig } from "./config.js";
import { probeSandboxIdleMs, reapOrphanContainers } from "./reaper.js";

const config = loadSandboxConfig({ SANDBOX_ENABLED: "true" } as NodeJS.ProcessEnv);
const DAY = 24 * 60 * 60 * 1000;

function fakeDocker(containers: Array<{ Id: string; Names: string[]; State: string; Created: number }>) {
	const stopped: string[] = [];
	const removed: string[] = [];
	const docker = {
		listContainers: async () => containers,
		getContainer: (id: string) => ({
			stop: async () => void stopped.push(id),
			remove: async () => void removed.push(id),
			inspect: async () => ({
				State: { Running: true },
				NetworkSettings: {
					Ports: {
						"6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7001" }],
						"3080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7002" }],
					},
				},
			}),
		}),
	} as unknown as Docker;
	return { docker, stopped, removed };
}

const old = Math.floor((Date.now() - 3 * DAY) / 1000);

describe("reaper: órfãos só dormem se comprovadamente ociosos", () => {
	vi.spyOn(console, "log").mockImplementation(() => undefined);

	it("VM antiga mas em uso pelo worker (idle curto) NÃO é parada", async () => {
		const { docker, stopped } = fakeDocker([{ Id: "a", Names: ["/atlas-sandbox-a"], State: "running", Created: old }]);
		await reapOrphanContainers(docker, config, new Set(), { ttlMs: 900_000, hardTtlMs: Infinity, probe: async () => 5_000 });
		expect(stopped).toEqual([]);
	});

	it("sem resposta de /idle (imagem antiga, rede): não para", async () => {
		const { docker, stopped } = fakeDocker([{ Id: "a", Names: ["/atlas-sandbox-a"], State: "running", Created: old }]);
		await reapOrphanContainers(docker, config, new Set(), { ttlMs: 900_000, hardTtlMs: Infinity, probe: async () => null });
		expect(stopped).toEqual([]);
	});

	it("ociosa além do TTL: dorme", async () => {
		const { docker, stopped } = fakeDocker([{ Id: "a", Names: ["/atlas-sandbox-a"], State: "running", Created: old }]);
		await reapOrphanContainers(docker, config, new Set(), { ttlMs: 900_000, hardTtlMs: Infinity, probe: async () => 3_600_000, idleStop: true });
		expect(stopped).toEqual(["a"]);
	});

	it("sem idleStop (padrão) a VM ociosa NÃO é parada", async () => {
		const { docker, stopped } = fakeDocker([{ Id: "a", Names: ["/atlas-sandbox-a"], State: "running", Created: old }]);
		await reapOrphanContainers(docker, config, new Set(), { ttlMs: 900_000, hardTtlMs: Infinity, probe: async () => 3_600_000 });
		expect(stopped).toEqual([]);
	});

	it("container conhecido deste processo é ignorado", async () => {
		const { docker, stopped } = fakeDocker([{ Id: "a", Names: ["/atlas-sandbox-a"], State: "running", Created: old }]);
		await reapOrphanContainers(docker, config, new Set(["atlas-sandbox-a"]), { ttlMs: 1, hardTtlMs: Infinity, probe: async () => 9e9, idleStop: true });
		expect(stopped).toEqual([]);
	});

	it("probeSandboxIdleMs lê /idle do control server", async () => {
		const { docker } = fakeDocker([]);
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ idleMs: 1234 }) })) as unknown as typeof fetch;
		expect(await probeSandboxIdleMs(docker, config, "a", fetchImpl)).toBe(1234);
		const notFound = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
		expect(await probeSandboxIdleMs(docker, config, "a", notFound)).toBeNull();
	});
});
