import { describe, expect, it } from "vitest";
import { validateAccountConfigPatch } from "./account-config.js";
import {
	MAINTENANCE_JOB_KINDS,
	applyMaintenanceResult,
	friendlyMaintenanceError,
	maintenanceStatusView,
	parseMaintenanceStatus,
} from "./maintenance-status.js";
import { buildMaintenanceCandidates, isMaintenanceFallbackError, isMaintenanceModel } from "./provider-policy.js";

const keys = (over: Partial<Record<"openrouter" | "anthropic" | "opencode-go", boolean>> = {}) => ({ openrouter: false, anthropic: false, "opencode-go": false, ...over });

describe("buildMaintenanceCandidates", () => {
	it("escolhido com chave vem primeiro, depois padrão da conta e do servidor", () => {
		const list = buildMaintenanceCandidates({ chosen: "anthropic-direct/c", accountDefault: "opencode-go/g", serverDefault: "v/cheap", keys: keys({ openrouter: true, anthropic: true, "opencode-go": true }) });
		expect(list.map((c) => c.model)).toEqual(["anthropic-direct/c", "opencode-go/g", "v/cheap"]);
	});
	it("sem escolha: servidor barato antes do padrão da conta", () => {
		const list = buildMaintenanceCandidates({ accountDefault: "anthropic-direct/c", serverDefault: "v/cheap", keys: keys({ openrouter: true, anthropic: true }) });
		expect(list.map((c) => c.role)).toEqual(["server-default", "account-default"]);
	});
	it("pula provedores sem chave, repetidos e o plano ChatGPT", () => {
		const list = buildMaintenanceCandidates({ chosen: "chatgpt/x", accountDefault: "chatgpt/y", serverDefault: "v/cheap", keys: keys({ openrouter: true }) });
		expect(list.map((c) => c.model)).toEqual(["v/cheap"]);
		expect(buildMaintenanceCandidates({ chosen: "v/cheap", serverDefault: "v/cheap", keys: keys({ openrouter: true }) })).toHaveLength(1);
	});
	it("nenhuma chave = lista vazia", () => {
		expect(buildMaintenanceCandidates({ chosen: "anthropic-direct/c", serverDefault: "v/cheap", keys: keys() })).toEqual([]);
	});
	it("isMaintenanceModel recusa ChatGPT e vazio", () => {
		expect(isMaintenanceModel("chatgpt/gpt")).toBe(false);
		expect(isMaintenanceModel("")).toBe(false);
		expect(isMaintenanceModel("opencode-go/x")).toBe(true);
	});
});

describe("isMaintenanceFallbackError", () => {
	it("política de dados, modelo indisponível, 400/404 e auth trocam de candidato", () => {
		expect(isMaintenanceFallbackError({ status: 404, message: "No endpoints found" })).toBe(true);
		expect(isMaintenanceFallbackError({ status: 401 })).toBe(true);
		expect(isMaintenanceFallbackError({ status: 502, message: "0 endpoints available matching your data policy" })).toBe(true);
	});
	it("erro transitório não troca", () => {
		expect(isMaintenanceFallbackError({ status: 503, message: "upstream" })).toBe(false);
		expect(isMaintenanceFallbackError(new Error("timeout"))).toBe(false);
		expect(isMaintenanceFallbackError(null)).toBe(false);
	});
});

describe("contrato do modelo de manutenção", () => {
	it("aceita Anthropic e OpenCode Go, recusa ChatGPT", () => {
		expect(validateAccountConfigPatch({ models: { maintenance: "anthropic-direct/claude-x" } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ models: { maintenance: "opencode-go/glm" } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ models: { maintenance: "chatgpt/gpt-5" } }).ok).toBe(false);
	});
});

describe("estado das tarefas de manutenção", () => {
	it("sucesso e erro ficam separados; sanitiza o JSON", () => {
		const at = new Date("2026-10-19T12:00:00Z");
		let store = applyMaintenanceResult({}, "summary", { ok: true, at });
		store = applyMaintenanceResult(store, "summary", { ok: false, at: new Date("2026-10-19T13:00:00Z"), message: "Chave inválida" });
		const view = maintenanceStatusView(parseMaintenanceStatus(JSON.parse(JSON.stringify(store))));
		expect(view.map((v) => v.kind)).toEqual([...MAINTENANCE_JOB_KINDS]);
		expect(view[0]).toEqual({ kind: "summary", lastSuccessAt: at.toISOString(), lastError: { message: "Chave inválida", at: "2026-10-19T13:00:00.000Z" } });
		expect(view[1]).toEqual({ kind: "memory-review", lastSuccessAt: null, lastError: null });
		expect(parseMaintenanceStatus("lixo")).toEqual({});
		expect(parseMaintenanceStatus({ summary: { successAt: "nope", error: { message: 1, at: "x" } } })).toEqual({});
	});
	it("mensagem amigável: uma linha, sem credencial, truncada", () => {
		const text = friendlyMaintenanceError(new Error(`falhou Authorization: Bearer abcdefghijklmnop\n${"x".repeat(500)}`));
		expect(text).not.toContain("abcdefghijklmnop");
		expect(text).not.toContain("\n");
		expect(text.length).toBeLessThanOrEqual(200);
	});
});
