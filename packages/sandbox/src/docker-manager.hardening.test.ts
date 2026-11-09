import { describe, expect, it } from "vitest";
import { loadSandboxConfig } from "./config.js";
import { sandboxHardening } from "./docker-manager.js";

describe("endurecimento do container da VM", () => {
	it("tira NET_RAW e MKNOD, mantém o resto (sudo atlas-install precisa de SETUID/SETGID) e limita processos", () => {
		const hardening = sandboxHardening(loadSandboxConfig({} as NodeJS.ProcessEnv));
		expect(hardening.CapDrop).toEqual(["NET_RAW", "MKNOD"]);
		expect(hardening.PidsLimit).toBe(4096);
		for (const needed of ["SETUID", "SETGID", "CHOWN", "AUDIT_WRITE", "DAC_OVERRIDE"]) expect(hardening.CapDrop).not.toContain(needed);
		expect(hardening.CapDrop).not.toContain("ALL");
	});

	it("SANDBOX_PIDS_LIMIT ajusta; 0 desliga; valor inválido volta ao padrão", () => {
		expect(sandboxHardening(loadSandboxConfig({ SANDBOX_PIDS_LIMIT: "512" } as NodeJS.ProcessEnv)).PidsLimit).toBe(512);
		expect(sandboxHardening(loadSandboxConfig({ SANDBOX_PIDS_LIMIT: "0" } as NodeJS.ProcessEnv))).not.toHaveProperty("PidsLimit");
		expect(sandboxHardening(loadSandboxConfig({ SANDBOX_PIDS_LIMIT: "abc" } as NodeJS.ProcessEnv)).PidsLimit).toBe(4096);
	});
});
