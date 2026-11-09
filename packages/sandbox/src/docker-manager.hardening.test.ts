import { describe, expect, it } from "vitest";
import { loadSandboxConfig } from "./config.js";
import { capDropOutdated, resourceLimitsOutdated, resourceLimitsUpdate, sandboxHardening } from "./docker-manager.js";

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

describe("VMs que já existem (F8 auditoria #11)", () => {
	const config = loadSandboxConfig({ SANDBOX_PIDS_LIMIT: "512" } as NodeJS.ProcessEnv);
	it("o update inclui PidsLimit e o limite ausente na VM antiga conta como desatualizado", () => {
		expect(resourceLimitsUpdate(config)).toMatchObject({ PidsLimit: 512 });
		const base = { Memory: config.memoryBytes, NanoCpus: config.nanoCpus };
		expect(resourceLimitsOutdated(config, { HostConfig: base })).toBe(true);
		expect(resourceLimitsOutdated(config, { HostConfig: { ...base, PidsLimit: null } })).toBe(true);
		expect(resourceLimitsOutdated(config, { HostConfig: { ...base, PidsLimit: 512 } })).toBe(false);
	});
	it("PIDS desligado de propósito não força update", () => {
		const off = loadSandboxConfig({ SANDBOX_PIDS_LIMIT: "0" } as NodeJS.ProcessEnv);
		expect(resourceLimitsUpdate(off)).not.toHaveProperty("PidsLimit");
		expect(resourceLimitsOutdated(off, { HostConfig: { Memory: off.memoryBytes, NanoCpus: off.nanoCpus } })).toBe(false);
	});
	it("capDropOutdated acusa container sem o CapDrop atual e aceita o formato CAP_*", () => {
		expect(capDropOutdated({ HostConfig: {} })).toBe(true);
		expect(capDropOutdated({ HostConfig: { CapDrop: ["NET_RAW"] } })).toBe(true);
		expect(capDropOutdated({ HostConfig: { CapDrop: ["CAP_NET_RAW", "CAP_MKNOD"] } })).toBe(false);
		expect(capDropOutdated({ HostConfig: { CapDrop: sandboxHardening(config).CapDrop } })).toBe(false);
	});
});
