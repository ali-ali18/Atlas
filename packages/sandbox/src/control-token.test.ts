import { afterEach, describe, expect, it, vi } from "vitest";
import {
	controlActivity,
	controlBrowserClick,
	controlBrowserV4,
	controlCardFill,
	controlClick,
	controlNavigate,
	controlScreen,
	controlScreenshot,
	controlBrowserLinks,
} from "./control-client.js";
import { controlAuthHeader, controlTokenFromInspect, generateControlToken, setControlToken } from "./control-token.js";
import { loadSandboxConfig } from "./config.js";
import { probeSandboxIdleMs } from "./reaper-probe.js";

afterEach(() => vi.unstubAllGlobals());

describe("token do control server", () => {
	it("gera 32 bytes aleatórios em base64url, diferentes a cada chamada", () => {
		const a = generateControlToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(generateControlToken()).not.toBe(a);
	});

	it("relê o token do Config.Env do inspect (reinício do worker) e ignora container sem ele", () => {
		expect(controlTokenFromInspect({ Config: { Env: ["PATH=/bin", "SANDBOX_CONTROL_TOKEN=abc_-123", "SANDBOX_TLS=false"] } })).toBe("abc_-123");
		expect(controlTokenFromInspect({ Config: { Env: ["SANDBOX_CONTROL_TOKEN="] } })).toBeUndefined();
		expect(controlTokenFromInspect({ Config: { Env: ["PATH=/bin"] } })).toBeUndefined();
		expect(controlTokenFromInspect({ Config: null })).toBeUndefined();
		expect(controlTokenFromInspect(undefined)).toBeUndefined();
	});

	it("o cabeçalho é por endpoint: VM sem token não manda Authorization", () => {
		setControlToken("vm-a", 3080, "tok-a");
		expect(controlAuthHeader("vm-a", 3080)).toEqual({ Authorization: "Bearer tok-a" });
		expect(controlAuthHeader("vm-b", 3080)).toEqual({});
		setControlToken("vm-a", 3080, undefined);
		expect(controlAuthHeader("vm-a", 3080)).toEqual({});
	});
});

describe("cliente do control server envia Authorization em todas as chamadas", () => {
	it("POST, GET, GET binário e /screen levam o Bearer da VM, junto da aba do subagente", async () => {
		setControlToken("vm-c", 3080, "tok-c");
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
				return new Response(JSON.stringify({ ok: true, idleMs: 1, busy: false }), { status: 200 });
			}),
		);
		await controlNavigate("vm-c", 3080, "https://example.com");
		await controlClick("vm-c", 3080, 1, 2);
		await controlScreenshot("vm-c", 3080);
		await controlScreen("vm-c", 3080);
		await controlActivity("vm-c", 3080);
		await controlBrowserLinks("vm-c", 3080);
		await controlBrowserClick("vm-c", 3080, { text: "x" }, { tabId: "t1" });
		await controlBrowserV4("vm-c", 3080, {} as never);
		await controlCardFill("vm-c", 3080, {} as never);
		expect(calls.length).toBe(9);
		for (const call of calls) expect(call.headers.Authorization, call.url).toBe("Bearer tok-c");
		expect(calls[6]!.headers["x-atlas-tab"]).toBe("t1");
		setControlToken("vm-c", 3080, undefined);
	});

	it("o sonda do reaper (/idle) manda o token lido do inspect", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ idleMs: 42 }), { status: 200 }));
		const docker = {
			getContainer: () => ({
				inspect: async () => ({
					State: { Running: true },
					Config: { Env: ["SANDBOX_CONTROL_TOKEN=tok-probe"] },
					NetworkSettings: { Ports: { "6080/tcp": [{ HostPort: "7001" }], "3080/tcp": [{ HostPort: "7002" }] } },
				}),
			}),
		};
		const config = loadSandboxConfig({ SANDBOX_ENABLED: "true" } as NodeJS.ProcessEnv);
		const idle = await probeSandboxIdleMs(docker as never, config, "c1", fetchMock as never);
		expect(idle).toBe(42);
		const init = fetchMock.mock.calls[0]![1]!;
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-probe");
	});
});
