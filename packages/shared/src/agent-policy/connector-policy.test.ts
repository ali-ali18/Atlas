import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../redact-secrets.js";
import { classifyMcpEffect, confirmWritesRules, isPrivateConnector } from "./connector-policy.js";
import { decide } from "./decide.js";
import type { DecideInput } from "./types.js";

const clean = { untrustedReadInRun: false, argsCarryUntrusted: false };
const mk = (over: Partial<DecideInput> = {}): DecideInput => ({ effect: "write_external", surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [], taint: clean, now: new Date("2026-11-06T12:00:00Z"), ...over });

describe("classifyMcpEffect", () => {
	it("readOnlyHint sem destructiveHint é leitura", () => {
		expect(classifyMcpEffect({ name: "do_thing", annotations: { readOnlyHint: true } })).toBe("read");
	});
	it("destructiveHint é destrutivo", () => {
		expect(classifyMcpEffect({ name: "do_thing", annotations: { destructiveHint: true } })).toBe("destructive");
	});
	it("readOnlyHint com verbo irreversível no nome nunca é leitura", () => {
		expect(classifyMcpEffect({ name: "delete_all", annotations: { readOnlyHint: true } })).toBe("destructive");
	});
	it("sem anotação é escrita externa, mesmo com nome de leitura", () => {
		expect(classifyMcpEffect({ name: "list_events" })).toBe("write_external");
		expect(classifyMcpEffect({ name: "mystery", annotations: {} })).toBe("write_external");
	});
	it("marca do dono promove a leitura só sem anotação", () => {
		expect(classifyMcpEffect({ name: "list_events" }, { ownerMark: "read" })).toBe("read");
		expect(classifyMcpEffect({ name: "list_events", annotations: { readOnlyHint: false } }, { ownerMark: "read" })).toBe("write_external");
	});
	it("verbo irreversível no nome sem anotação é destrutivo", () => {
		expect(classifyMcpEffect({ name: "delete_event" })).toBe("destructive");
	});
});

describe("isPrivateConnector", () => {
	it("desconhecido, personalizado e sem catálogo são privados", () => {
		expect(isPrivateConnector(null)).toBe(true);
		expect(isPrivateConnector(undefined)).toBe(true);
		expect(isPrivateConnector("nao-existe")).toBe(true);
	});
	it("e-mail, drive e agenda do catálogo são privados", () => {
		for (const id of ["gmail", "google_drive", "google_calendar", "slack", "notion"]) expect(isPrivateConnector(id), id).toBe(true);
	});
});

describe("isPrivateConnector (catálogo público)", () => {
	it("busca na web do catálogo não é dado do dono", () => {
		expect(isPrivateConnector("firecrawl")).toBe(false);
		expect(isPrivateConnector("brave_search")).toBe(false);
	});
});

describe("confirmWritesRules", () => {
	const rules = confirmWritesRules([
		{ confirmWrites: true, writeToolName: "mcp_a_write" },
		{ confirmWrites: false, writeToolName: "mcp_b_write" },
	]);
	it("só o conector com confirmWrites gera regra approve", () => {
		expect(rules).toEqual([{ match: "mcp_a_write", verdict: "approve" }]);
	});
	it("o decide pede cartão onde a autonomia deixaria rodar", () => {
		const action = (toolName: string) => ({ toolName });
		expect(decide(mk({ rules, action: action("mcp_a_write") })).kind).toBe("approve");
		expect(decide(mk({ rules, action: action("mcp_b_write") })).kind).toBe("run");
	});
});

describe("sanitizeErrorMessage", () => {
	it("redige token e segredo conhecido e limita o tamanho", () => {
		const out = sanitizeErrorMessage(new Error("falhou com Bearer abcdefghijklmnop1234 e hunter2-secret"), ["hunter2-secret"]);
		expect(out).not.toContain("abcdefghijklmnop1234");
		expect(out).not.toContain("hunter2-secret");
		expect(sanitizeErrorMessage("x".repeat(900))).toHaveLength(500);
	});
});
