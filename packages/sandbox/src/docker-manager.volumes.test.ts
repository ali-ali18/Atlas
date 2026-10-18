import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	calls: [] as string[],
	created: [] as Array<{ HostConfig: { Binds?: string[] } }>,
	volumeError: undefined as { statusCode: number } | undefined,
	execs: [] as Array<Record<string, unknown>>,
}));

vi.mock("dockerode", () => {
	const ports = {
		"6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7001" }],
		"3080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7002" }],
	};
	const container = (id: string) => ({
		inspect: async () => ({ Id: id, Image: "sha256:new", State: { Running: true }, NetworkSettings: { Ports: ports } }),
		start: async () => undefined,
		stop: async () => void state.calls.push(`stop:${id}`),
		remove: async (opts: unknown) => void state.calls.push(`remove:${id}:${JSON.stringify(opts)}`),
		exec: async (opts: Record<string, unknown>) => {
			state.execs.push(opts);
			return {
				start: async () => {
					const { PassThrough } = await import("node:stream");
					const stream = new PassThrough();
					queueMicrotask(() => stream.end());
					return stream;
				},
				inspect: async () => ({ ExitCode: 0 }),
			};
		},
	});
	class Docker {
		modem = { demuxStream: (stream: { resume: () => void }, out: { write: (b: Buffer) => void }) => { out.write(Buffer.from("ok")); stream.resume(); } };
		getContainer(id: string) {
			return container(id);
		}
		getImage() {
			return { inspect: async () => ({ Id: "sha256:new" }) };
		}
		getVolume(name: string) {
			return {
				remove: async (opts: unknown) => {
					state.calls.push(`volume-remove:${name}:${JSON.stringify(opts)}`);
					if (state.volumeError) throw state.volumeError;
				},
			};
		}
		async listContainers() {
			return [{ Id: "c-old", Names: ["/atlas-sandbox-s1"], Labels: { "atlas.sandbox.userId": "u1", "atlas.sandbox.conversationId": "conv-x", "atlas.sandbox.sessionId": "s1" } }];
		}
		async createContainer(opts: (typeof state.created)[number]) {
			state.created.push(opts);
			return container("fresh");
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

import { createSandboxManager, profileVolumeName, sandboxBinds, workVolumeName } from "./docker-manager.js";
import { loadSandboxConfig } from "./config.js";
import { deleteSession, listAllSessionsForCleanup } from "./session-store.js";

const config = loadSandboxConfig({ SANDBOX_ENABLED: "true", SANDBOX_PROFILE_VOLUMES: "1" } as NodeJS.ProcessEnv);

describe("sandbox volumes e shell via manager", () => {
	beforeEach(() => {
		for (const r of listAllSessionsForCleanup()) deleteSession(r.sessionId, r.userId);
		state.calls = [];
		state.created = [];
		state.execs = [];
		state.volumeError = undefined;
		vi.stubGlobal("fetch", async () => ({ ok: true }));
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	it("nomes de volume são estáveis, por dono+conversa, e distintos entre perfil e trabalho", () => {
		expect(profileVolumeName("c", "u")).toBe(profileVolumeName("c", "u"));
		expect(profileVolumeName("c", "u")).toMatch(/^atlas-profile-[a-f0-9]{64}$/);
		expect(workVolumeName("c", "u")).toMatch(/^atlas-work-[a-f0-9]{64}$/);
		expect(workVolumeName("c", "u")).not.toBe(workVolumeName("c", "v"));
		expect(sandboxBinds("c", "u")).toEqual([
			`${profileVolumeName("c", "u")}:/tmp/chrome-data`,
			`${workVolumeName("c", "u")}:/home/atlas/work`,
		]);
	});

	it("createSession monta perfil e work; sem conversa ou com volumes desligados não monta", async () => {
		await createSandboxManager(config, "u1").createSession("conv-x");
		expect(state.created[0]!.HostConfig.Binds).toEqual(sandboxBinds("conv-x", "u1"));
		await createSandboxManager(config, "u1").createSession(undefined);
		expect(state.created[1]!.HostConfig.Binds).toBeUndefined();
		const off = loadSandboxConfig({ SANDBOX_ENABLED: "true", SANDBOX_PROFILE_VOLUMES: "0" } as NodeJS.ProcessEnv);
		await createSandboxManager(off, "u1").createSession("conv-y");
		expect(state.created[2]!.HostConfig.Binds).toBeUndefined();
	});

	it("clearBrowserProfile remove o container (v:false) e só o volume do perfil, depois do container", async () => {
		const manager = createSandboxManager(config, "u1");
		const result = await manager.clearBrowserProfile("conv-x");
		expect(result).toEqual({ cleared: true, removedContainers: 1 });
		expect(state.calls).toContain("stop:c-old");
		expect(state.calls.find((c) => c.startsWith("remove:c-old"))).toContain('"v":false');
		const volumeCalls = state.calls.filter((c) => c.startsWith("volume-remove"));
		expect(volumeCalls).toHaveLength(1);
		expect(volumeCalls[0]).toContain(profileVolumeName("conv-x", "u1"));
		expect(volumeCalls[0]).not.toContain("atlas-work");
		expect(state.calls.findIndex((c) => c.startsWith("remove:"))).toBeLessThan(state.calls.findIndex((c) => c.startsWith("volume-remove")));
	});

	it("clearBrowserProfile ignora volume inexistente (404), propaga outros erros e respeita o dono", async () => {
		state.volumeError = { statusCode: 404 };
		await expect(createSandboxManager(config, "u1").clearBrowserProfile("conv-x")).resolves.toMatchObject({ cleared: true });
		state.volumeError = { statusCode: 409 };
		await expect(createSandboxManager(config, "u1").clearBrowserProfile("conv-x")).rejects.toBeDefined();
		state.volumeError = undefined;
		expect((await createSandboxManager(config, "u2").clearBrowserProfile("conv-x")).removedContainers).toBe(0);
	});

	it("execShell roda docker exec como atlas dentro do container da sessão e nega sessão alheia", async () => {
		const owner = createSandboxManager(config, "u1");
		const session = await owner.createSession("conv-x");
		const result = await owner.execShell(session.sessionId, { command: "echo ok" });
		expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
		expect(state.execs[0]).toMatchObject({ User: "atlas", WorkingDir: "/home/atlas/work", AttachStdout: true });
		expect((state.execs[0] as { Cmd: string[] }).Cmd).toEqual(["timeout", "-k", "3", "60", "bash", "-lc", "echo ok"]);
		await expect(createSandboxManager(config, "u2").execShell(session.sessionId, { command: "id" })).rejects.toThrow("not found");
		expect(state.execs).toHaveLength(1);
	});
});
