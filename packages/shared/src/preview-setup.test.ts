import { describe, expect, it } from "vitest";
import {
	createSetupState, isPublicIpv4, nextSetupStep, parsePreviewSetupState, previewProbeHost, rollbackTargets, validateSetupDomain, withStep,
} from "./preview-setup.js";
import { previewBaseDomainConflict, previewIdFromHost } from "./preview.js";

const base = { domain: "previas.exemplo.com", dnsProvider: "cloudflare", tls: "origin-cert", platform: "dokploy", serverIp: "203.0.113.7" } as const;

describe("isPublicIpv4", () => {
	it("aceita público e recusa privado, loopback, CGNAT, link-local e lixo", () => {
		expect(isPublicIpv4("203.0.113.7")).toBe(true);
		for (const bad of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.20.0.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "256.1.1.1", "1.2.3", "a.b.c.d", 5, ""]) {
			expect(isPublicIpv4(bad)).toBe(false);
		}
	});
});

describe("validateSetupDomain", () => {
	it("normaliza e aceita domínio separado", () => {
		expect(validateSetupDomain("https://*.Previas.Exemplo.com/", "https://atlas.meusite.com")).toEqual({ domain: "previas.exemplo.com" });
	});
	it("recusa inválido, IP, porta e mesmo site do Atlas", () => {
		for (const bad of [undefined, "", "localhost", "1.2.3.4", "foo.com:8080", "semponto"]) {
			expect("error" in validateSetupDomain(bad, "https://atlas.meusite.com")).toBe(true);
		}
		expect("error" in validateSetupDomain("previas.meusite.com", "https://atlas.meusite.com")).toBe(true);
	});
	it("sufixos privados (dedyn.io, duckdns.org) são sites separados", () => {
		expect(previewBaseDomainConflict("previas.dedyn.io", "https://atlas.dedyn.io")).toBeNull();
		expect(previewBaseDomainConflict("previas.duckdns.org", "https://atlas.duckdns.org")).toBeNull();
		expect(previewBaseDomainConflict("a.dedyn.io", "https://a.dedyn.io")).not.toBeNull();
		expect("domain" in validateSetupDomain("previas.dedyn.io", "https://atlas.dedyn.io")).toBe(true);
	});
});

describe("estado do setup", () => {
	it("o host de teste é reconhecido como prévia pelo proxy", () => {
		expect(previewIdFromHost(previewProbeHost("previas.exemplo.com"), "previas.exemplo.com")).not.toBeNull();
	});
	it("próximo passo segue a ordem e termina em null", () => {
		let state = createSetupState(base);
		expect(nextSetupStep(state)).toBe("dns");
		for (const id of ["dns", "tls", "route", "env", "redeploy", "probe"] as const) state = withStep(state, id, { status: "done" }, new Date(0));
		expect(nextSetupStep(state)).toBeNull();
	});
	it("só desfaz o que o setup criou", () => {
		let state = createSetupState(base);
		expect(rollbackTargets(state)).toBeNull();
		state = withStep(state, "dns", { status: "done", created: { zoneId: "z1", recordIds: ["r1"] } }, new Date(0));
		expect(rollbackTargets(state)).toEqual({ zoneId: "z1", recordIds: ["r1"] });
	});
	it("parse tolera lixo e preserva o válido", () => {
		expect(parsePreviewSetupState(null)).toBeNull();
		expect(parsePreviewSetupState({ v: 2 })).toBeNull();
		expect(parsePreviewSetupState({ ...createSetupState(base), serverIp: "10.0.0.1" })).toBeNull();
		const state = withStep(createSetupState(base), "dns", { status: "done", detail: "ok" }, new Date(0));
		expect(parsePreviewSetupState(JSON.parse(JSON.stringify(state)))).toEqual(state);
		const broken = { ...state, steps: { dns: { status: "???" } } };
		expect(parsePreviewSetupState(broken)?.steps.dns.status).toBe("pending");
	});
});
