import { describe, expect, it, vi } from "vitest";
import { loadDevSandboxConfig, type DevSandboxConfig } from "./config.js";
import { buildDevContainerSpec, createDockerDevProvider, resolveDevEndpoint } from "./docker-provider.js";
import { createEgressGateway, networkForPolicy, wantsInternalNetwork } from "./egress-network.js";

const config: DevSandboxConfig = {
	...loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true", DEV_SANDBOX_CONNECT_MODE: "network", DEV_SANDBOX_NETWORK_MODE: "atlas-sandbox" }),
};
const allow = { mode: "allowlist" as const, allowlist: ["github.com"] };

describe("config de aplicação na rede", () => {
	it("auto: liga em connectMode=network e desliga em published", () => {
		expect(config.egressEnforce).toBe(true);
		const published = loadDevSandboxConfig({ DEV_SANDBOX_CONNECT_MODE: "published" });
		expect(published.egressEnforce).toBe(false);
		expect(published.egressEnforceUnavailable).toBe(false);
		const forced = loadDevSandboxConfig({ DEV_SANDBOX_CONNECT_MODE: "published", DEV_SANDBOX_EGRESS_ENFORCE: "network" });
		expect(forced.egressEnforce).toBe(false);
		expect(forced.egressEnforceUnavailable).toBe(true);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CONNECT_MODE: "network", DEV_SANDBOX_EGRESS_ENFORCE: "off" }).egressEnforce).toBe(false);
	});
});

describe("seleção de rede por modo", () => {
	it("allowlist e off vão para a rede interna; full e sem ambiente aberto, para a normal", () => {
		expect(networkForPolicy(config, allow)).toBe("dev-egress-internal");
		expect(networkForPolicy(config, { mode: "off", allowlist: [] })).toBe("dev-egress-internal");
		expect(networkForPolicy(config, { mode: "full", allowlist: [] })).toBe("atlas-sandbox");
		expect(networkForPolicy(config, undefined)).toBe("atlas-sandbox");
		expect(wantsInternalNetwork({ ...config, egressMode: "allowlist" }, undefined)).toBe(true);
	});
	it("sem aplicação na rede, tudo fica na rede normal", () => {
		expect(networkForPolicy({ ...config, egressEnforce: false }, allow)).toBe("atlas-sandbox");
	});
	it("o container interno usa o proxy do gateway e não publica porta", () => {
		const spec = buildDevContainerSpec(config, { sessionId: "s", userId: "u", tier: "small", token: "t", egress: allow });
		expect(spec.HostConfig?.NetworkMode).toBe("dev-egress-internal");
		expect(spec.Env).toContain("DEV_EGRESS_PROXY_URL=http://dev-egress-gateway:3128");
		expect(spec.HostConfig?.PortBindings).toBeUndefined();
	});
	it("o endpoint usa o IP da rede interna quando o container está nela", () => {
		const inspect = {
			Config: { Env: ["DEV_SANDBOX_TOKEN=abc"] },
			NetworkSettings: { Networks: { "dev-egress-internal": { IPAddress: "172.30.0.7" } } },
		};
		expect(resolveDevEndpoint(config, inspect)).toEqual({ baseUrl: "http://172.30.0.7:3090", token: "abc" });
	});
});

type FakeContainer = { running: boolean; networks: Record<string, { IPAddress: string }>; env: string[]; spec?: any };

function fakeDocker(options: { networkInternal?: boolean | "missing" } = {}) {
	const calls: string[] = [];
	const containers = new Map<string, FakeContainer>();
	let ipCounter = 10;
	const state = { networkExists: options.networkInternal !== "missing" };
	const getContainer = (raw: string) => {
		const name = raw.startsWith("id-") ? raw.slice(3) : raw;
		return {
			id: `id-${name}`,
			inspect: async () => {
				const c = containers.get(name);
				if (!c) throw Object.assign(new Error("no such"), { statusCode: 404 });
				return { Id: `id-${name}`, Image: "sha:1", State: { Running: c.running }, Config: { Env: c.env }, NetworkSettings: { Networks: c.networks } };
			},
			start: async () => {
				calls.push(`start ${name}`);
				containers.get(name)!.running = true;
			},
			remove: async () => {
				containers.delete(name);
			},
		};
	};
	const net = (network: string) => ({
		inspect: async () => {
			if (!state.networkExists) throw Object.assign(new Error("no such"), { statusCode: 404 });
			return { Internal: options.networkInternal !== false };
		},
		connect: async ({ Container }: { Container: string }) => {
			calls.push(`connect ${Container} ${network}`);
			containers.get(Container.slice(3))!.networks[network] = { IPAddress: `172.30.0.${ipCounter++}` };
		},
		disconnect: async ({ Container }: { Container: string }) => {
			calls.push(`disconnect ${Container} ${network}`);
			delete containers.get(Container.slice(3))!.networks[network];
		},
	});
	const docker = {
		listContainers: async () => [],
		getContainer,
		getNetwork: net,
		createNetwork: async (spec: { Name: string; Internal: boolean }) => {
			calls.push(`createNetwork ${spec.Name} internal=${spec.Internal}`);
			state.networkExists = true;
		},
		createContainer: async (spec: any) => {
			calls.push(`createContainer ${spec.name}`);
			containers.set(spec.name, {
				running: false,
				networks: { [spec.HostConfig.NetworkMode]: { IPAddress: `172.30.0.${ipCounter++}` } },
				env: spec.Env,
				spec,
			});
			return getContainer(spec.name);
		},
		getImage: () => ({ inspect: async () => ({ Id: "sha:1" }) }),
		getVolume: () => ({ remove: async () => undefined }),
	};
	return { docker: docker as never, calls, containers };
}

describe("gateway de saída", () => {
	it("cria a rede interna e o gateway nas duas redes, idempotente", async () => {
		const f = fakeDocker({ networkInternal: "missing" });
		const doFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		const gateway = createEgressGateway(config, { docker: () => f.docker, fetch: doFetch, sleep: async () => undefined });
		expect(await gateway.ensure()).toEqual({ fresh: true });
		expect(f.calls).toContain("createNetwork dev-egress-internal internal=true");
		const gw = f.containers.get("dev-egress-gateway")!;
		expect(gw.spec.HostConfig).toMatchObject({ NetworkMode: "atlas-sandbox", RestartPolicy: { Name: "unless-stopped" }, CapDrop: ["ALL"], Memory: 128 * 1024 * 1024 });
		expect(gw.spec.Labels).toMatchObject({ "atlas.dev-egress": "gateway" });
		expect(Object.keys(gw.networks).sort()).toEqual(["atlas-sandbox", "dev-egress-internal"]);
		expect(await gateway.ensure()).toEqual({ fresh: false });
		expect(f.calls.filter((c) => c.startsWith("createNetwork"))).toHaveLength(1);
		expect(f.calls.filter((c) => c.startsWith("createContainer"))).toHaveLength(1);
	});
	it("recusa uma rede existente que não é interna (falha fechada)", async () => {
		const f = fakeDocker({ networkInternal: false });
		const gateway = createEgressGateway(config, { docker: () => f.docker, fetch: vi.fn() as never, sleep: async () => undefined });
		await expect(gateway.ensure()).rejects.toThrow(/internal/);
	});
	it("registra a política pelo controle autenticado", async () => {
		const f = fakeDocker();
		const doFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const gateway = createEgressGateway(config, { docker: () => f.docker, fetch: doFetch as never, sleep: async () => undefined });
		await gateway.ensure();
		await gateway.register("172.30.0.50", allow, "s1");
		const call = doFetch.mock.calls.find((c) => String(c[0]).includes("/sessions/172.30.0.50")) as unknown as [string, any];
		expect(call[1]).toMatchObject({ method: "PUT" });
		expect(call[1].headers.authorization).toMatch(/^Bearer [0-9a-f]{48}$/);
		expect(JSON.parse(call[1].body)).toEqual({ mode: "allowlist", allowlist: ["github.com"], sessionId: "s1" });
	});
});

describe("provider com gateway", () => {
	const common = { hostFreeMb: () => 8000, sleep: async () => undefined, healthCheck: async () => true };

	it("allowlist: container só na rede interna; off mantém; full volta para a rede normal", async () => {
		const f = fakeDocker();
		const puts: Array<{ url: string; body: any }> = [];
		const globalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: any) => {
			if (init?.method === "PUT") puts.push({ url: String(url), body: JSON.parse(init.body) });
			return new Response("{}", { status: 200 });
		}) as never;
		try {
			const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
			const result = await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small", egress: allow });
			expect(result).toMatchObject({ status: "running" });
			const dev = f.containers.get("dev-s1")!;
			expect(Object.keys(dev.networks)).toEqual(["dev-egress-internal"]);
			expect(puts).toHaveLength(1);
			expect(puts[0]!.url).toContain(`/sessions/${dev.networks["dev-egress-internal"]!.IPAddress}`);
			expect(puts[0]!.body).toMatchObject({ mode: "allowlist", sessionId: "s1" });
			await provider.setEgress!("s1", { mode: "off", allowlist: [] });
			expect(puts.at(-1)!.body.mode).toBe("off");
			expect(Object.keys(dev.networks)).toEqual(["dev-egress-internal"]);
			await provider.setEgress!("s1", { mode: "full", allowlist: [] });
			expect(Object.keys(dev.networks)).toEqual(["atlas-sandbox"]);
		} finally {
			globalThis.fetch = globalFetch;
		}
	});

	it("full: não toca em rede interna nem em gateway", async () => {
		const f = fakeDocker();
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		await provider.ensureRunning({ sessionId: "s2", userId: "u1", tier: "small", egress: { mode: "full", allowlist: [] } });
		expect(Object.keys(f.containers.get("dev-s2")!.networks)).toEqual(["atlas-sandbox"]);
		expect(f.containers.has("dev-egress-gateway")).toBe(false);
	});

	it("modo published: sem gateway, avisa e mantém a rede normal", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const published = { ...config, egressEnforce: false };
		const f = fakeDocker();
		const provider = createDockerDevProvider(published, { docker: f.docker, ...common });
		await provider.ensureRunning({ sessionId: "s3", userId: "u1", tier: "small", egress: allow }).catch(() => undefined);
		expect(f.containers.get("dev-s3")!.spec.HostConfig.NetworkMode).toBe("atlas-sandbox");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("melhor esforço"));
		warn.mockRestore();
	});
});
