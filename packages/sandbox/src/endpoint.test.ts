import { describe, expect, it } from "vitest";
import { resolveSandboxEndpoint } from "./docker-manager.js";

const published = {
	NetworkSettings: {
		Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49001" }], "3080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49002" }] },
		Networks: { "atlas-sandbox": { IPAddress: "172.30.0.5" } },
	},
};

describe("resolveSandboxEndpoint", () => {
	it("network: IP interno da rede configurada e portas do container (sem porta publicada)", () => {
		const r = resolveSandboxEndpoint({ connectMode: "network", networkMode: "atlas-sandbox", controlHost: "host.docker.internal" }, published);
		expect(r?.host).toBe("172.30.0.5");
		expect(r).toEqual({ host: "172.30.0.5", viewerPort: 6080, controlPort: 3080 });
	});
	it("network sem IP naquela rede: null (erro claro em vez de esperar pra sempre)", () => {
		expect(resolveSandboxEndpoint({ connectMode: "network", networkMode: "outra", controlHost: "x" }, published)).toBeNull();
	});
	it("published: porta publicada no host via controlHost", () => {
		expect(resolveSandboxEndpoint({ connectMode: "published", networkMode: "bridge", controlHost: "host.docker.internal" }, published)).toEqual({ host: "host.docker.internal", viewerPort: 49001, controlPort: 49002 });
	});
});

import { loadSandboxConfig } from "./config.js";

describe("viewerMode tolerante", () => {
	it("SANDBOX_VIEWER_HOST=proxy por engano vira modo proxy", () => {
		expect(loadSandboxConfig({ SANDBOX_VIEWER_HOST: "proxy" } as NodeJS.ProcessEnv).viewerMode).toBe("proxy");
	});
	it("connect=network sem modo explícito usa proxy; direct explícito é respeitado", () => {
		expect(loadSandboxConfig({ SANDBOX_CONNECT_MODE: "network" } as NodeJS.ProcessEnv).viewerMode).toBe("proxy");
		expect(loadSandboxConfig({ SANDBOX_CONNECT_MODE: "network", SANDBOX_VIEWER_MODE: "direct" } as NodeJS.ProcessEnv).viewerMode).toBe("direct");
		expect(loadSandboxConfig({} as NodeJS.ProcessEnv).viewerMode).toBe("direct");
	});
});
