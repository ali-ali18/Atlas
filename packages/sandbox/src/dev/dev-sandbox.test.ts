import { describe, expect, it, vi } from "vitest";
import { decideAdmission } from "./admission.js";
import { signDevCallback, verifyDevCallback } from "./callback.js";
import { createDevClient, DevSandboxError } from "./client.js";
import { DEV_TIERS, loadDevSandboxConfig, type DevSandboxConfig } from "./config.js";
import {
	buildDevContainerSpec,
	createDockerDevProvider,
	devCacheVolumeName,
	devContainerName,
	devWorkspaceVolumeName,
	resolveDevEndpoint,
} from "./docker-provider.js";
import { reapDevSessionsOnce, type DevReaperStore } from "./reaper.js";

const config: DevSandboxConfig = { ...loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }), connectMode: "network", networkMode: "atlas-sandbox" };

describe("config", () => {
	it("usa os padrões do plano", () => {
		const c = loadDevSandboxConfig({});
		expect(c.maxConcurrent).toBe(2);
		expect(c.idleMs).toBe(10 * 60_000);
		expect(c.defaultTier).toBe("small");
		expect(c.pidsLimit).toBe(512);
		expect(c.egressMode).toBe("open");
		expect(c.image).toBe("atlas-dev-sandbox:latest");
		expect(c.enabled).toBe(false);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }).enabled).toBe(true);
	});
	it("lê overrides e ignora valores inválidos", () => {
		const c = loadDevSandboxConfig({ DEV_SANDBOX_MAX_CONCURRENT: "4", DEV_SANDBOX_IDLE_MS: "abc", DEV_SANDBOX_DEFAULT_TIER: "large" });
		expect(c.maxConcurrent).toBe(4);
		expect(c.idleMs).toBe(10 * 60_000);
		expect(c.defaultTier).toBe("large");
	});
	it("DEV_SANDBOX_SMALL_CPUS ajusta só o tier pequeno e ignora valores inválidos", () => {
		expect(loadDevSandboxConfig({}).smallCpus).toBe(2);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_SMALL_CPUS: "1.5" }).smallCpus).toBe(1.5);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_SMALL_CPUS: "abc" }).smallCpus).toBe(2);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_SMALL_CPUS: "0" }).smallCpus).toBe(2);
		const spec = (smallCpus: number, tier: "small" | "medium") =>
			buildDevContainerSpec({ ...config, smallCpus }, { sessionId: "s1", userId: "u", tier, token: "t" }).HostConfig?.NanoCpus;
		expect(spec(1.5, "small")).toBe(1.5e9);
		expect(spec(1.5, "medium")).toBe(2e9);
	});
	it("mapeia tiers", () => {
		expect(DEV_TIERS).toEqual({
			small: { memoryMb: 1024, cpus: 2 },
			medium: { memoryMb: 2560, cpus: 2 },
			large: { memoryMb: 4096, cpus: 2 },
		});
	});
});

describe("decideAdmission", () => {
	const base = { requestedMb: 1024, maxConcurrent: 2, memoryBudgetMb: 4096, minFreeMb: 512 };
	it("admite com folga", () => {
		expect(decideAdmission({ ...base, running: [{ memoryMb: 1024 }], hostFreeMb: 4000 })).toEqual({ admit: true });
	});
	it("nega por concorrência", () => {
		const d = decideAdmission({ ...base, running: [{ memoryMb: 1024 }, { memoryMb: 1024 }] });
		expect(d).toMatchObject({ admit: false, reason: "max_concurrent" });
	});
	it("nega por orçamento de memória", () => {
		const d = decideAdmission({ ...base, maxConcurrent: 5, running: [{ memoryMb: 4096 }] });
		expect(d).toMatchObject({ admit: false, reason: "memory_budget" });
	});
	it("nega por memória livre do host e ignora quando desconhecida", () => {
		expect(decideAdmission({ ...base, running: [], hostFreeMb: 1200 })).toMatchObject({ admit: false, reason: "host_memory" });
		expect(decideAdmission({ ...base, running: [] })).toEqual({ admit: true });
	});
});

describe("buildDevContainerSpec", () => {
	it("aplica limites do tier, volumes e isolamento", () => {
		const spec = buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "medium", token: "tok" });
		expect(spec.name).toBe("dev-s1");
		expect(spec.Env).toContain("DEV_SANDBOX_TOKEN=tok");
		expect(spec.HostConfig).toMatchObject({
			Memory: 2560 * 1024 * 1024,
			MemorySwap: 2560 * 1024 * 1024,
			NanoCpus: 2e9,
			PidsLimit: 512,
			NetworkMode: "atlas-sandbox",
			CapDrop: ["ALL"],
		});
		expect(spec.HostConfig?.Binds).toEqual([`${devWorkspaceVolumeName("s1")}:/workspace`, `${devCacheVolumeName("u1")}:/cache`]);
		expect(spec.HostConfig?.PortBindings).toBeUndefined();
		expect(spec.Labels).toMatchObject({ "atlas.dev-sandbox": "true", "atlas.dev-sandbox.memoryMb": "2560" });
	});
	it("publica a porta só em 127.0.0.1 no modo published", () => {
		const spec = buildDevContainerSpec({ ...config, connectMode: "published" }, { sessionId: "s", userId: "u", tier: "small", token: "t" });
		expect(spec.HostConfig?.PortBindings).toEqual({ "3090/tcp": [{ HostIp: "127.0.0.1" }] });
	});
	it("cache é por usuário e o workspace por sessão", () => {
		expect(devCacheVolumeName("u1")).toBe(devCacheVolumeName("u1"));
		expect(devCacheVolumeName("u1")).not.toBe(devCacheVolumeName("u2"));
		expect(devWorkspaceVolumeName("a")).not.toBe(devWorkspaceVolumeName("b"));
	});
});

describe("resolveDevEndpoint", () => {
	const inspect = {
		Config: { Env: ["A=1", "DEV_SANDBOX_TOKEN=abc"] },
		NetworkSettings: {
			Ports: { "3090/tcp": [{ HostIp: "127.0.0.1", HostPort: "49321" }] },
			Networks: { "atlas-sandbox": { IPAddress: "172.20.0.5" } },
		},
	};
	it("rede compartilhada", () => {
		expect(resolveDevEndpoint(config, inspect)).toEqual({ baseUrl: "http://172.20.0.5:3090", token: "abc" });
	});
	it("porta publicada", () => {
		expect(resolveDevEndpoint({ ...config, connectMode: "published", controlHost: "127.0.0.1" }, inspect)).toEqual({
			baseUrl: "http://127.0.0.1:49321",
			token: "abc",
		});
	});
	it("sem token ou sem endereço devolve null", () => {
		expect(resolveDevEndpoint(config, { ...inspect, Config: { Env: [] } })).toBeNull();
		expect(resolveDevEndpoint(config, { Config: inspect.Config })).toBeNull();
	});
});

function fakeDocker(options: { running?: Array<{ mem: number }>; existing?: "running" | "stopped" | "none"; staleImage?: boolean } = {}) {
	const existing = options.existing ?? "none";
	const containers = new Map<string, { running: boolean }>();
	if (existing !== "none") containers.set("dev-s1", { running: existing === "running" });
	const created: unknown[] = [];
	const removed: string[] = [];
	const inspectOf = (name: string) => ({
		Id: `id-${name}`,
		Image: "sha:old",
		State: { Running: containers.get(name)?.running ?? false },
		Config: { Env: ["DEV_SANDBOX_TOKEN=tok"] },
		NetworkSettings: { Networks: { "atlas-sandbox": { IPAddress: "10.0.0.9" } } },
	});
	const getContainer = (name: string) => ({
		inspect: async () => {
			if (!containers.has(name)) throw Object.assign(new Error("no such"), { statusCode: 404 });
			return inspectOf(name);
		},
		start: async () => {
			containers.set(name, { running: true });
		},
		stop: async () => {
			containers.set(name, { running: false });
		},
		remove: async () => {
			removed.push(name);
			containers.delete(name);
		},
	});
	return {
		created,
		removed,
		containers,
		docker: {
			listContainers: async () => (options.running ?? []).map((item) => ({ Labels: { "atlas.dev-sandbox.memoryMb": String(item.mem) } })),
			getContainer: (name: string) => getContainer(name.startsWith("id-") ? name.slice(3) : name),
			createContainer: async (spec: { name: string }) => {
				created.push(spec);
				containers.set(spec.name, { running: false });
				return getContainer(spec.name);
			},
			getImage: () => ({ inspect: async () => ({ Id: options.staleImage ? "sha:new" : "sha:old" }) }),
			getVolume: () => ({ remove: async () => undefined }),
		} as never,
	};
}

describe("provider docker (dockerode simulado)", () => {
	const common = { hostFreeMb: () => 8000, sleep: async () => undefined, healthCheck: async () => true };

	it("cria e sobe quando há folga", async () => {
		const f = fakeDocker();
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		const result = await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small" });
		expect(result).toMatchObject({ status: "running", resumed: false, endpoint: { baseUrl: "http://10.0.0.9:3090", token: "tok" } });
		expect(f.created).toHaveLength(1);
	});

	it("devolve queued sem criar nada quando o teto de concorrência estourou", async () => {
		const f = fakeDocker({ running: [{ mem: 1024 }, { mem: 1024 }] });
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		const result = await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small" });
		expect(result).toMatchObject({ status: "queued", denied: { reason: "max_concurrent" } });
		expect(f.created).toHaveLength(0);
	});

	it("não aplica admissão a um container que já está rodando", async () => {
		const f = fakeDocker({ existing: "running", running: [{ mem: 1024 }, { mem: 1024 }] });
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		expect(await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small" })).toMatchObject({ status: "running", resumed: false });
	});

	it("religa o container parado reutilizando-o", async () => {
		const f = fakeDocker({ existing: "stopped" });
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		const result = await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small" });
		expect(result).toMatchObject({ status: "running", resumed: true });
		expect(f.created).toHaveLength(0);
	});

	it("recria (mantendo o volume) quando a imagem mudou", async () => {
		const f = fakeDocker({ existing: "stopped", staleImage: true });
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		const result = await provider.ensureRunning({ sessionId: "s1", userId: "u1", tier: "small" });
		expect(f.removed).toEqual(["dev-s1"]);
		expect(f.created).toHaveLength(1);
		expect(result).toMatchObject({ status: "running", resumed: false });
	});

	it("stop e inspect refletem o estado", async () => {
		const f = fakeDocker({ existing: "running" });
		const provider = createDockerDevProvider(config, { docker: f.docker, ...common });
		expect((await provider.inspect("s1")).state).toBe("running");
		await provider.stop("s1");
		expect((await provider.inspect("s1")).state).toBe("stopped");
		expect((await provider.inspect("nada")).state).toBe("missing");
		expect(devContainerName("s1")).toBe("dev-s1");
	});
});

describe("reaper", () => {
	function store(idle: string[], expired: string[]) {
		const statuses: Array<[string, string]> = [];
		const s: DevReaperStore = {
			listIdle: vi.fn(async () => idle.map((id) => ({ id, userId: "u" }))),
			listExpired: vi.fn(async () => expired.map((id) => ({ id, userId: "u" }))),
			setStatus: vi.fn(async (id, status) => {
				statuses.push([id, status]);
			}),
		};
		return { s, statuses };
	}
	const provider = (jobs = 0) => ({
		ensureRunning: vi.fn(),
		stop: vi.fn(async () => undefined),
		destroy: vi.fn(async () => undefined),
		inspect: vi.fn(),
		endpoint: vi.fn(),
		runningJobs: vi.fn(async () => jobs),
	});

	it("para ociosas (STOPPED) e expira antigas removendo o volume", async () => {
		const { s, statuses } = store(["a"], ["b"]);
		const p = provider();
		const result = await reapDevSessionsOnce({ provider: p, store: s, idleMs: 600_000, expireMs: 1_000_000, log: () => undefined });
		expect(result.stopped).toEqual(["a"]);
		expect(result.expired).toEqual(["b"]);
		expect(p.destroy).toHaveBeenCalledWith("b", { removeVolume: true });
		expect(statuses).toEqual([["a", "STOPPED"], ["b", "EXPIRED"]]);
	});

	it("poupa sessão com comando rodando até 3x o tempo ocioso", async () => {
		const s: DevReaperStore = {
			listIdle: vi.fn(async (before: Date) => (before.getTime() > 0 && Date.now() - before.getTime() < 700_000 ? [{ id: "a", userId: "u" }] : [])),
			listExpired: vi.fn(async () => []),
			setStatus: vi.fn(async () => undefined),
		};
		const p = provider(2);
		const result = await reapDevSessionsOnce({ provider: p, store: s, idleMs: 600_000, expireMs: 1e9, log: () => undefined });
		expect(result.skippedBusy).toEqual(["a"]);
		expect(p.stop).not.toHaveBeenCalled();
	});

	describe("jobs em segundo plano", () => {
		const open = (startedAt: number) => ({
			listIdle: vi.fn(async () => [{ id: "a", userId: "u", conversationId: "c" }]),
			listExpired: vi.fn(async () => []),
			setStatus: vi.fn(async () => undefined),
			listOpenJobs: vi.fn(async () => [{ startedAt }]),
			onEnded: vi.fn(async () => undefined),
		});
		const NOW = 10_000_000;

		it("não para o container enquanto o job roda dentro do teto de 30 min", async () => {
			const s = open(NOW - 20 * 60_000);
			const p = provider(1);
			const result = await reapDevSessionsOnce({ provider: p, store: s, idleMs: 600_000, expireMs: 1e12, now: () => NOW, log: () => undefined });
			expect(result.skippedBusy).toEqual(["a"]);
			expect(p.stop).not.toHaveBeenCalled();
			expect(s.onEnded).not.toHaveBeenCalled();
		});

		it("passou do teto: para e registra o fim dos jobs com timeout", async () => {
			const s = open(NOW - 31 * 60_000);
			const p = provider(1);
			const result = await reapDevSessionsOnce({ provider: p, store: s, idleMs: 600_000, expireMs: 1e12, now: () => NOW, log: () => undefined });
			expect(result.stopped).toEqual(["a"]);
			expect(s.onEnded).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "timeout");
		});

		it("ocioso sem job rodando: para e registra stopped para os jobs abertos (ex.: já morreram)", async () => {
			const s = open(NOW - 60_000);
			const p = provider(0);
			await reapDevSessionsOnce({ provider: p, store: s, idleMs: 600_000, expireMs: 1e12, now: () => NOW, log: () => undefined });
			expect(p.stop).toHaveBeenCalledWith("a");
			expect(s.onEnded).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "stopped");
		});

		it("expirar sessão registra lost", async () => {
			const s = { ...open(NOW), listIdle: vi.fn(async () => []), listExpired: vi.fn(async () => [{ id: "b", userId: "u" }]) };
			await reapDevSessionsOnce({ provider: provider(0), store: s, idleMs: 1, expireMs: 1, now: () => NOW, log: () => undefined });
			expect(s.onEnded).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "lost");
		});
	});
});

describe("client", () => {
	it("envia bearer e traduz erros", async () => {
		const calls: Array<{ url: string; auth: string | null }> = [];
		const fetchFn = (async (url: string, init: RequestInit) => {
			calls.push({ url, auth: new Headers(init.headers).get("authorization") });
			return url.endsWith("/files?path=x") ? new Response(JSON.stringify({ error: "nao" }), { status: 404 }) : new Response(JSON.stringify({ id: "abc" }), { status: 200 });
		}) as unknown as typeof fetch;
		const client = createDevClient({ baseUrl: "http://h:3090", token: "T" }, { fetchFn });
		expect(await client.execStart({ cmd: "ls" })).toEqual({ id: "abc" });
		expect(calls[0]).toEqual({ url: "http://h:3090/exec", auth: "Bearer T" });
		await expect(client.readFile({ path: "x" })).rejects.toMatchObject({ status: 404, message: "nao" });
		await expect(client.readFile({ path: "x" })).rejects.toBeInstanceOf(DevSandboxError);
	});
});

describe("política de internet", () => {
	it("sem ambiente usa o modo da config (open vira full)", () => {
		const spec = buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "small", token: "tok" });
		expect(spec.Env).toContain("DEV_EGRESS_MODE=full");
	});
	it("com ambiente leva modo e domínios para o container", () => {
		const spec = buildDevContainerSpec(config, {
			sessionId: "s1",
			userId: "u1",
			tier: "small",
			token: "tok",
			egress: { mode: "allowlist", allowlist: ["github.com", "*.npmjs.org"] },
		});
		expect(spec.Env).toContain("DEV_EGRESS_MODE=allowlist");
		expect(spec.Env).toContain("DEV_EGRESS_ALLOWLIST=github.com,*.npmjs.org");
	});
	it("teto global de tier", () => {
		expect(loadDevSandboxConfig({}).maxTier).toBe("large");
		expect(loadDevSandboxConfig({ DEV_SANDBOX_MAX_TIER: "medium" }).maxTier).toBe("medium");
		expect(loadDevSandboxConfig({ DEV_SANDBOX_MAX_TIER: "x" }).maxTier).toBe("large");
	});
	it("cliente aplica a política por PUT /egress", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ mode: "off", allowlist: [] }), { status: 200 }));
		const client = createDevClient({ baseUrl: "http://x", token: "t" }, { fetchFn: fetchFn as unknown as typeof fetch });
		await client.setEgress({ mode: "off", allowlist: [] });
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://x/egress");
		expect(init.method).toBe("PUT");
	});
});

describe("callback de fim de job", () => {
	it("deriva a URL do modo de conexão e aceita override/off", () => {
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CONNECT_MODE: "network", PORT: "3001" }).callbackUrl).toBe("http://api:3001/v1/internal/dev-jobs/callback");
		expect(loadDevSandboxConfig({ PORT: "4000" }).callbackUrl).toBe("http://host.docker.internal:4000/v1/internal/dev-jobs/callback");
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CALLBACK_URL: "http://x/cb" }).callbackUrl).toBe("http://x/cb");
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CALLBACK_URL: "off" }).callbackUrl).toBe("");
	});
	it("passa sessão e URL ao container (e host-gateway só no modo publicado)", () => {
		const net = buildDevContainerSpec({ ...config, callbackUrl: "http://api:3001/cb" }, { sessionId: "s1", userId: "u1", tier: "small", token: "tok" });
		expect(net.Env).toContain("DEV_SANDBOX_SESSION_ID=s1");
		expect(net.Env).toContain("DEV_SANDBOX_CALLBACK_URL=http://api:3001/cb");
		expect(net.HostConfig?.ExtraHosts).toBeUndefined();
		const pub = buildDevContainerSpec({ ...config, connectMode: "published", callbackUrl: "" }, { sessionId: "s1", userId: "u1", tier: "small", token: "tok" });
		expect(pub.Env?.some((e) => e.startsWith("DEV_SANDBOX_CALLBACK_URL"))).toBe(false);
		expect(pub.HostConfig?.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
	});
});

describe("assinatura do callback", () => {
	const body = '{"sessionId":"s1","jobId":"a"}';
	const ts = String(Math.floor(Date.now() / 1000));
	const sig = `sha256=${signDevCallback("tok", "s1", ts, body)}`;
	it("aceita a assinatura válida", () => {
		expect(verifyDevCallback({ token: "tok", sessionId: "s1", timestamp: ts, signature: sig, body })).toBe(true);
	});
	it("recusa outra sessão, outro token, corpo adulterado, relógio velho e cabeçalho ruim", () => {
		expect(verifyDevCallback({ token: "tok", sessionId: "s2", timestamp: ts, signature: sig, body })).toBe(false);
		expect(verifyDevCallback({ token: "outro", sessionId: "s1", timestamp: ts, signature: sig, body })).toBe(false);
		expect(verifyDevCallback({ token: "tok", sessionId: "s1", timestamp: ts, signature: sig, body: body.replace("a", "b") })).toBe(false);
		expect(verifyDevCallback({ token: "tok", sessionId: "s1", timestamp: ts, signature: sig, body, now: Date.now() + 10 * 60_000 })).toBe(false);
		expect(verifyDevCallback({ token: "tok", sessionId: "s1", timestamp: ts, signature: "sha256=zz", body })).toBe(false);
		expect(verifyDevCallback({ token: "tok", sessionId: "s1", timestamp: undefined, signature: sig, body })).toBe(false);
	});
});
