import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeContainer = {
	id: string;
	name: string;
	labels: Record<string, string>;
	state: "running" | "exited" | "dead" | "created";
	exitCode?: number;
	oomKilled?: boolean;
	startError?: string;
};

const fake = vi.hoisted(() => ({
	containers: new Map<string, FakeContainer>(),
	calls: [] as string[],
	removeOpts: [] as unknown[],
	seq: 0,
	hangCreate: false,
	createCount: 0,
	/** Chamadas de /health: falham até este número, depois respondem ok. */
	healthFailures: 0,
	healthCalls: 0,
	healthAlwaysFail: false,
	controlDown: false,
	networkContainers: {} as Record<string, { Name: string }>,
	disconnected: [] as string[],
}));

vi.mock("dockerode", () => {
	const ports = {
		"6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7001" }],
		"3080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7002" }],
	};
	const notFound = () => Object.assign(new Error("no such container"), { statusCode: 404 });
	const handle = (ref: string) => {
		const find = () => [...fake.containers.values()].find((c) => c.id === ref || c.name === ref);
		return {
			inspect: async () => {
				const c = find();
				if (!c) throw notFound();
				return {
					Id: c.id,
					Image: "sha256:new",
					State: {
						Running: c.state === "running",
						Status: c.state,
						Dead: c.state === "dead",
						ExitCode: c.exitCode ?? 0,
						OOMKilled: c.oomKilled ?? false,
						FinishedAt: "2026-10-17T10:00:00Z",
					},
					HostConfig: { Memory: 2048 * 1024 * 1024 },
					NetworkSettings: { Ports: ports },
				};
			},
			start: async () => {
				const c = find();
				if (!c) throw notFound();
				fake.calls.push(`start:${c.name}`);
				if (c.startError) throw new Error(c.startError);
				c.state = "running";
			},
			stop: async () => {
				const c = find();
				if (c) fake.calls.push(`stop:${c.name}`);
			},
			remove: async (opts: unknown) => {
				const c = find();
				if (!c) throw notFound();
				fake.calls.push(`remove:${c.name}`);
				fake.removeOpts.push(opts);
				fake.containers.delete(c.id);
			},
		};
	};
	class Docker {
		getContainer(ref: string) {
			return handle(ref);
		}
		getImage() {
			return { inspect: async () => ({ Id: "sha256:new" }) };
		}
		getNetwork() {
			return {
				inspect: async () => ({ Containers: fake.networkContainers }),
				disconnect: async (opts: { Container: string }) => void fake.disconnected.push(opts.Container),
			};
		}
		async listContainers(options: { filters: { label: string[] } }) {
			const wanted = options.filters.label;
			return [...fake.containers.values()]
				.filter((c) => wanted.every((w) => (w.includes("=") ? c.labels[w.split("=")[0]!] === w.split("=")[1] : w in c.labels)))
				.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.labels, State: c.state }));
		}
		async createContainer(opts: { name: string; Labels: Record<string, string> }) {
			fake.createCount += 1;
			if (fake.hangCreate) await new Promise(() => undefined);
			if ([...fake.containers.values()].some((c) => c.name === opts.name)) {
				throw Object.assign(new Error(`name "${opts.name}" is already in use`), { statusCode: 409 });
			}
			const c: FakeContainer = { id: `id-${++fake.seq}`, name: opts.name, labels: opts.Labels, state: "created" };
			fake.containers.set(c.id, c);
			return handle(c.id);
		}
	}
	return { default: Docker };
});

vi.mock("node:net", () => ({
	createConnection: () => {
		const socket = {
			setTimeout: () => undefined,
			destroy: () => undefined,
			once(event: string, cb: () => void) {
				if (event === "connect") queueMicrotask(cb);
				return socket;
			},
		};
		return socket;
	},
}));

import { SandboxVmDiedError, createSandboxManager } from "./docker-manager.js";
import { loadSandboxConfig } from "./config.js";
import { deleteSession, listAllSessionsForCleanup, putSession } from "./session-store.js";

const config = loadSandboxConfig({
	SANDBOX_ENABLED: "true",
	SANDBOX_PROFILE_VOLUMES: "1",
} as NodeJS.ProcessEnv);

const USER = "user-recover";
const labelsFor = (conversationId: string, sessionId: string) => ({
	"atlas.sandbox": "true",
	"atlas.sandbox.userId": USER,
	"atlas.sandbox.sessionId": sessionId,
	"atlas.sandbox.conversationId": conversationId,
});

function seed(partial: Partial<FakeContainer> & { name: string; conversationId: string }): FakeContainer {
	const c: FakeContainer = {
		id: `seed-${++fake.seq}`,
		name: partial.name,
		labels: labelsFor(partial.conversationId, partial.name.replace("atlas-sandbox-", "")),
		state: partial.state ?? "exited",
		exitCode: partial.exitCode,
		oomKilled: partial.oomKilled,
		startError: partial.startError,
	};
	fake.containers.set(c.id, c);
	return c;
}

describe("docker-manager: recuperação de start após morte", () => {
	let errors: string[];

	beforeEach(() => {
		for (const record of listAllSessionsForCleanup()) deleteSession(record.sessionId, record.userId);
		fake.containers.clear();
		fake.calls = [];
		fake.removeOpts = [];
		fake.hangCreate = false;
		fake.createCount = 0;
		fake.healthFailures = 0;
		fake.healthCalls = 0;
		fake.healthAlwaysFail = false;
		fake.controlDown = false;
		fake.networkContainers = {};
		fake.disconnected = [];
		errors = [];
		process.env.SANDBOX_READY_DELAY_MS = "1";
		process.env.SANDBOX_READY_TIMEOUT_MS = "2000";
		vi.stubGlobal("fetch", async () => {
			fake.healthCalls += 1;
			if (fake.healthAlwaysFail || fake.controlDown || fake.healthCalls <= fake.healthFailures) throw new Error("fetch failed");
			return { ok: true };
		});
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
	});

	afterEach(() => {
		delete process.env.SANDBOX_READY_DELAY_MS;
		delete process.env.SANDBOX_READY_TIMEOUT_MS;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("linha fantasma (running no store, container sumiu): getSession some e resolveSession cria outra", async () => {
		putSession({
			userId: USER, sessionId: "ghost", conversationId: "conv-g", containerId: "gone", containerName: "atlas-sandbox-ghost",
			status: "running", viewerPort: 7001, controlPort: 7002, createdAt: new Date(), lastUsedAt: new Date(),
		});
		const manager = createSandboxManager(config, USER);
		expect(await manager.getSession("ghost")).toBeNull();
		const session = await manager.resolveSession("conv-g");
		expect(session.sessionId).not.toBe("ghost");
		expect(session.status).toBe("running");
	});

	it("container Exited que não religa: remove (sem apagar volume) e cria outro, sem conflito de nome", async () => {
		seed({ name: "atlas-sandbox-old", conversationId: "conv-x", state: "exited", exitCode: 137, startError: "endpoint already exists in network" });
		const manager = createSandboxManager(config, USER);
		const session = await manager.resolveSession("conv-x");
		expect(session.status).toBe("running");
		expect([...fake.containers.values()].map((c) => c.name)).not.toContain("atlas-sandbox-old");
		expect(fake.calls).toContain("remove:atlas-sandbox-old");
		expect(fake.removeOpts.every((o) => (o as { v?: boolean }).v === false)).toBe(true);
		// causa registrada
		expect(errors.some((e) => e.includes("container-death") && e.includes("\"exitCode\":137"))).toBe(true);
	});

	it("container Dead: não tenta religar, remove e cria novo", async () => {
		seed({ name: "atlas-sandbox-dead", conversationId: "conv-d", state: "dead" });
		const session = await createSandboxManager(config, USER).resolveSession("conv-d");
		expect(session.status).toBe("running");
		expect(fake.calls).not.toContain("start:atlas-sandbox-dead");
		expect(fake.calls).toContain("remove:atlas-sandbox-dead");
	});

	it("restos Created/Exited são varridos antes de criar (createSession direto)", async () => {
		seed({ name: "atlas-sandbox-c1", conversationId: "conv-c", state: "created" });
		seed({ name: "atlas-sandbox-c2", conversationId: "conv-c", state: "exited", oomKilled: true, exitCode: 137 });
		await createSandboxManager(config, USER).createSession("conv-c");
		const names = [...fake.containers.values()].map((c) => c.name);
		expect(names).not.toContain("atlas-sandbox-c1");
		expect(names).not.toContain("atlas-sandbox-c2");
		expect(errors.some((e) => e.includes("oom-killed"))).toBe(true);
	});

	it("endpoints órfãos na rede compartilhada são soltos", async () => {
		const shared = loadSandboxConfig({ SANDBOX_ENABLED: "true", SANDBOX_NETWORK_MODE: "atlas-sandbox-net" } as NodeJS.ProcessEnv);
		fake.networkContainers = { ghostEp: { Name: "atlas-sandbox-zumbi" }, other: { Name: "postgres" } };
		await createSandboxManager(shared, USER).createSession("conv-n");
		expect(fake.disconnected).toEqual(["ghostEp"]);
	});

	it("health demora: backoff até responder e a sessão sobe na mesma tentativa", async () => {
		fake.healthFailures = 5;
		const session = await createSandboxManager(config, USER).createSession("conv-slow");
		expect(session.status).toBe("running");
		expect(fake.createCount).toBe(1);
		expect(fake.healthCalls).toBe(6);
	});

	it("health nunca responde: refaz o start do zero até 3 tentativas e depois falha com erro claro", async () => {
		process.env.SANDBOX_READY_TIMEOUT_MS = "30";
		fake.healthAlwaysFail = true;
		await expect(createSandboxManager(config, USER).createSession("conv-never")).rejects.toThrow(/Failed to start sandbox container.*did not become ready/);
		expect(fake.createCount).toBe(3);
		expect(fake.containers.size).toBe(0);
		expect(listAllSessionsForCleanup()).toHaveLength(0);
	});

	it("1ª tentativa falha e a 2ª (container novo) funciona", async () => {
		process.env.SANDBOX_READY_TIMEOUT_MS = "30";
		fake.healthFailures = 1000;
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			// O 1º container nunca responde; depois da recriação responde de imediato.
			if (fake.createCount < 2) throw new Error("fetch failed");
			return { ok: true };
		});
		const session = await createSandboxManager(config, USER).createSession("conv-retry");
		expect(session.status).toBe("running");
		expect(fake.createCount).toBe(2);
		expect(calls).toBeGreaterThan(1);
	});

	it("trava de start parada além do TTL não bloqueia o próximo start", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		fake.hangCreate = true;
		const stuck = createSandboxManager(config, USER).createSession("conv-lock");
		stuck.catch(() => undefined);
		await vi.waitFor(() => expect(fake.createCount).toBe(1));
		fake.hangCreate = false;
		vi.setSystemTime(Date.now() + 6 * 60_000);
		const session = await createSandboxManager(config, USER).createSession("conv-lock");
		expect(session.status).toBe("running");
		expect(fake.createCount).toBe(2);
	});

	it("duas chamadas simultâneas da mesma conversa criam um só container (single-flight)", async () => {
		const manager = createSandboxManager(config, USER);
		const [a, b] = await Promise.all([manager.resolveSession("conv-sf"), manager.resolveSession("conv-sf")]);
		expect(a.sessionId).toBe(b.sessionId);
		expect(fake.createCount).toBe(1);
	});

	it("morte no meio da execução: marca a sessão como parada, loga a causa e o próximo start cria outra VM", async () => {
		const manager = createSandboxManager(config, USER);
		const session = await manager.resolveSession("conv-mid");
		expect(session.status).toBe("running");
		// VM morre (OOM) e o control server para de responder.
		const c = [...fake.containers.values()][0]!;
		c.state = "exited";
		c.exitCode = 137;
		c.oomKilled = true;
		fake.controlDown = true;
		vi.stubGlobal("fetch", async () => {
			if (fake.controlDown) throw new Error("fetch failed");
			return { ok: true };
		});
		const error = await manager.execClick(session.sessionId, 1, 1).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SandboxVmDiedError);
		expect((error as Error).message.toLowerCase()).toContain("session not found");
		expect(errors.some((e) => e.includes("oom-killed") && e.includes("\"oomKilled\":true"))).toBe(true);
		const after = await manager.getSession(session.sessionId);
		expect(after?.status).toBe("stopped");
		// Chamar start de novo: religa/recria sem esperar a sessão fantasma.
		fake.controlDown = false;
		const again = await manager.resolveSession("conv-mid");
		expect(again.status).toBe("running");
		// O container parado e religado (mesmo perfil); a sessão volta a running sem esperar fantasma.
		expect(fake.calls.some((call) => call.startsWith("start:"))).toBe(true);
	});

	it("VM viva mas lenta: erro de transporte não marca como morta", async () => {
		const manager = createSandboxManager(config, USER);
		const session = await manager.resolveSession("conv-alive");
		vi.stubGlobal("fetch", async () => {
			throw new Error("fetch failed");
		});
		await expect(manager.execClick(session.sessionId, 1, 1)).rejects.toThrow("fetch failed");
		expect((await manager.getSession(session.sessionId))?.status).toBe("running");
	});
});
