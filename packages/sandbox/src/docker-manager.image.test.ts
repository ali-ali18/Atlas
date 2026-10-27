import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	containerImage: "sha256:old",
	currentImage: "sha256:new" as string | null,
	owner: "user-image" as string | undefined,
	running: false,
	inspectLabels: null as Record<string, string> | null,
	list: null as Array<Record<string, unknown>> | null,
	calls: [] as string[],
	created: [] as Array<{ Image: string; Labels: Record<string, string>; HostConfig: { Binds?: string[] } }>,
}));

vi.mock("dockerode", () => {
	const ports = {
		"6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7001" }],
		"3080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7002" }],
	};
	const container = (id: string) => ({
		inspect: async () => ({
			Id: id,
			Image: id === "fresh" ? "sha256:new" : state.containerImage,
			State: { Running: id === "fresh" ? true : state.running },
			Config: { Labels: state.inspectLabels ?? { "atlas.sandbox.sessionId": "s1", "atlas.sandbox.userId": state.owner ?? "" } },
			NetworkSettings: { Ports: ports },
		}),
		start: async () => void state.calls.push(`start:${id}`),
		stop: async () => void state.calls.push(`stop:${id}`),
		remove: async (opts: unknown) =>
			void state.calls.push(`remove:${id}:${JSON.stringify(opts)}`),
	});
	class Docker {
		getContainer(id: string) {
			return container(id);
		}
		getImage() {
			return {
				inspect: async () => {
					if (state.currentImage === null) throw new Error("no such image");
					return { Id: state.currentImage };
				},
			};
		}
		async listContainers(options: { filters: { label: string[] } }) {
			if (state.list) return state.list;
			return [
				{
					Id: "old",
					Names: ["/atlas-sandbox-s1"],
					Labels: { "atlas.sandbox.sessionId": "s1", ...(state.owner ? { "atlas.sandbox.userId": state.owner } : {}), "atlas.sandbox.conversationId": options.filters.label.find((label) => label.startsWith("atlas.sandbox.conversationId="))?.split("=")[1] },
				},
			];
		}
		async createContainer(opts: (typeof state.created)[number]) {
			state.created.push(opts);
			state.calls.push("create");
			return container("fresh");
		}
	}
	return { default: Docker };
});

vi.mock("node:net", () => ({
	createConnection: () => {
		const handlers: Record<string, () => void> = {};
		const socket = {
			setTimeout: () => undefined,
			destroy: () => undefined,
			once(event: string, cb: () => void) {
				handlers[event] = cb;
				if (event === "connect") queueMicrotask(cb);
				return socket;
			},
		};
		return socket;
	},
}));

import { createSandboxManager, profileVolumeName, workVolumeName } from "./docker-manager.js";
import { loadSandboxConfig } from "./config.js";
import { deleteSession, listAllSessionsForCleanup as listSessions } from "./session-store.js";

const config = loadSandboxConfig({
	SANDBOX_ENABLED: "true",
	SANDBOX_PROFILE_VOLUMES: "1",
} as NodeJS.ProcessEnv);

describe("docker-manager: imagem desatualizada", () => {
	beforeEach(() => {
		for (const record of listSessions()) deleteSession(record.sessionId, record.userId);
		state.owner = "user-image";
		state.containerImage = "sha256:old";
		state.currentImage = "sha256:new";
		state.running = false;
		state.inspectLabels = null;
		state.list = null;
		state.calls = [];
		state.created = [];
		vi.stubGlobal("fetch", async () => ({ ok: true }));
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("não adota container de outro dono nem legado sem dono", async () => {
		const manager = createSandboxManager(config, "user-other");
		expect(await manager.getSessionForConversation("conv-private")).toBeNull();
		expect(await manager.getSession("s1")).toBeNull();
		state.owner = undefined;
		expect(await createSandboxManager(config, "user-image").getSessionForConversation("conv-legacy")).toBeNull();
		expect(state.calls).toEqual([]);
	});

	it("cria sessão com dono durável e bloqueia controles cruzados", async () => {
		const owner = createSandboxManager(config, "user-image");
		const session = await owner.createSession("conv-new");
		expect(state.created[0]?.Labels["atlas.sandbox.userId"]).toBe("user-image");
		const other = createSandboxManager(config, "user-other");
		expect(await other.getSession(session.sessionId)).toBeNull();
		expect(other.getViewerUrl(session.sessionId)).toBeNull();
		expect(await other.destroySession(session.sessionId)).toBe(false);
		expect(await other.stopSession(session.sessionId)).toBe(false);
		await expect(other.execClick(session.sessionId, 1, 1)).rejects.toThrow("not found");
		await expect(other.execScreenshot(session.sessionId)).rejects.toThrow("not found");
		expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(false);
	});

	it("adota por id de sessão após perda do store e exige dono explícito", async () => {
		state.containerImage = "sha256:new";
		expect(await createSandboxManager(config, "user-image").getSession("s1")).not.toBeNull();
		expect(() => createSandboxManager(config, "default")).toThrow("owner required");
		expect(() => createSandboxManager(config, "")).toThrow("owner required");
	});

	it("metadados de outro processo não iniciam nem recriam container parado", async () => {
		const metadata = await createSandboxManager(config, "user-image").getOwnedSessionMetadata("s1");
		expect(metadata?.status).toBe("stopped");
		expect(state.calls).toEqual([]);
		expect(profileVolumeName("same-conversation", "owner-a")).not.toBe(profileVolumeName("same-conversation", "owner-b"));
	});

	it("imagem antiga: remove sem volumes e recria com o mesmo volume de perfil", async () => {
		const manager = createSandboxManager(config, "user-image");
		const session = await manager.getSessionForConversation("conv-1");
		expect(session).not.toBeNull();
		const removeCall = state.calls.find((c) => c.startsWith("remove:old"));
		expect(removeCall).toBeDefined();
		expect(removeCall).toContain('"v":false');
		expect(state.created).toHaveLength(1);
		expect(state.created[0]!.Image).toBe(config.image);
		expect(state.created[0]!.HostConfig.Binds).toEqual([
			`${profileVolumeName("conv-1", "user-image")}:/tmp/chrome-data`,
			`${workVolumeName("conv-1", "user-image")}:/home/atlas/work`,
		]);
		expect(state.calls).not.toContain("start:old");
	});

	it("mesma imagem: reusa o container existente", async () => {
		state.containerImage = "sha256:new";
		const manager = createSandboxManager(config, "user-image");
		await manager.getSessionForConversation("conv-2");
		expect(state.created).toHaveLength(0);
		expect(state.calls.some((c) => c.startsWith("remove"))).toBe(false);
		expect(state.calls).toContain("start:old");
	});

	it("falha ao inspecionar a imagem: reusa o container", async () => {
		state.currentImage = null;
		const manager = createSandboxManager(config, "user-image");
		await manager.getSessionForConversation("conv-3");
		expect(state.created).toHaveLength(0);
		expect(state.calls.some((c) => c.startsWith("remove"))).toBe(false);
		expect(state.calls).toContain("start:old");
	});

	it("API só-leitura: container Running com imagem antiga não é parado/removido/recriado", async () => {
		state.running = true;
		const manager = createSandboxManager(config, "user-image");
		const session = await manager.getSessionForConversation("conv-4");
		expect(session?.sessionId).toBe("s1");
		expect(state.created).toHaveLength(0);
		expect(state.calls.some((c) => c.startsWith("stop:") || c.startsWith("remove"))).toBe(false);
	});

	it("poll do painel (wake:false): VM parada continua parada, sem start nem recriar", async () => {
		state.running = false;
		const manager = createSandboxManager(config, "user-image");
		expect(await manager.getSessionForConversation("conv-7", { wake: false })).toBeNull();
		expect(state.calls.some((c) => c.startsWith("start:") || c === "create" || c.startsWith("remove"))).toBe(false);
	});

	it("stopConversationSession desliga só a VM ligada do próprio dono, sem ligar nada", async () => {
		state.running = true;
		expect(await createSandboxManager(config, "user-image").stopConversationSession("conv-8")).toBe(true);
		expect(state.calls).toEqual(["stop:old"]);
		state.calls = [];
		expect(await createSandboxManager(config, "user-other").stopConversationSession("conv-8")).toBe(false);
		expect(state.calls).toEqual([]);
	});

	it("worker (resolveSession) ainda recria container Running com imagem antiga", async () => {
		state.running = true;
		const manager = createSandboxManager(config, "user-image");
		await manager.resolveSession("conv-5");
		expect(state.created).toHaveLength(1);
		expect(state.calls.some((c) => c.startsWith("remove:old"))).toBe(true);
	});

	it("vários containers na conversa: escolhe o mais recente (Created)", async () => {
		state.containerImage = "sha256:new";
		state.running = true;
		const label = (sid: string) => ({ "atlas.sandbox.sessionId": sid, "atlas.sandbox.userId": "user-image", "atlas.sandbox.conversationId": "conv-6" });
		state.list = [
			{ Id: "old", Names: ["/a"], Created: 100, Labels: label("s-old") },
			{ Id: "newer", Names: ["/b"], Created: 200, Labels: label("s-new") },
		];
		const session = await createSandboxManager(config, "user-image").getSessionForConversation("conv-6");
		expect(session?.sessionId).toBe("s-new");
	});

	it("resolveViewerTarget confere labels e Running no Docker", async () => {
		state.containerImage = "sha256:new";
		state.running = true;
		const manager = createSandboxManager(config, "user-image");
		expect(await manager.resolveViewerTarget("s1")).toMatchObject({ port: 7001 });
		// container agora pertence a outra sessão (IP/ID reaproveitado): não serve
		state.inspectLabels = { "atlas.sandbox.sessionId": "outra", "atlas.sandbox.userId": "user-image" };
		expect(await manager.resolveViewerTarget("s1")).toBeNull();
		state.inspectLabels = null;
		state.running = false;
		expect(await manager.resolveViewerTarget("s1")).toBeNull();
	});
});
