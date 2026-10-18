import { describe, expect, it } from "vitest";
import {
	ciCheckFailed,
	ciCheckPassed,
	ciSummaryText,
	DEV_HISTORY_EVENT_TYPES,
	DEV_SESSION_EVENT_TYPES,
	devPrStateFrom,
	isDevSessionEvent,
	parsePrReference,
	summarizeCi,
	type DevCiCheck,
} from "./dev-session.js";

const c = (status: DevCiCheck["status"], conclusion: string | null): DevCiCheck => ({ name: "x", status, conclusion });

describe("resumo do CI", () => {
	it("sem checks: none; tudo verde (inclui skipped/neutral): passing", () => {
		expect(summarizeCi([])).toBe("none");
		expect(summarizeCi([c("completed", "success"), c("completed", "skipped"), c("completed", "neutral")])).toBe("passing");
	});
	it("qualquer falha vence, mesmo com outros rodando", () => {
		expect(summarizeCi([c("completed", "success"), c("completed", "failure")])).toBe("failing");
		expect(summarizeCi([c("in_progress", null), c("completed", "timed_out")])).toBe("failing");
		expect(summarizeCi([c("completed", "cancelled")])).toBe("failing");
		expect(summarizeCi([c("completed", "action_required")])).toBe("failing");
	});
	it("sem falha e com algum em andamento ou na fila: pending", () => {
		expect(summarizeCi([c("completed", "success"), c("in_progress", null)])).toBe("pending");
		expect(summarizeCi([c("queued", null)])).toBe("pending");
	});
	it("predicados por verificação", () => {
		expect(ciCheckFailed(c("in_progress", "failure"))).toBe(false);
		expect(ciCheckPassed(c("completed", "skipped"))).toBe(true);
		expect(ciCheckPassed(c("completed", null))).toBe(false);
	});
	it("texto curto: 3 de 4 passaram, falhas primeiro, em andamento no fim", () => {
		expect(ciSummaryText([])).toBe("Sem verificações");
		expect(ciSummaryText([c("completed", "success"), c("completed", "success"), c("completed", "success"), c("completed", "skipped")])).toBe("4 de 4 passaram");
		expect(ciSummaryText([c("completed", "success"), c("completed", "success"), c("completed", "success"), c("completed", "failure")])).toBe("1 falhou · 3 de 4 passaram");
		expect(ciSummaryText([c("completed", "success")])).toBe("1 de 1 passou");
		expect(ciSummaryText([c("completed", "success"), c("in_progress", null)])).toBe("1 de 2 passou · 1 em andamento");
		expect(ciSummaryText([c("completed", "failure"), c("completed", "failure")])).toBe("2 falharam · 0 de 2 passaram");
	});
});

describe("PR", () => {
	it("estado: mesclado vence fechado; rascunho só quando aberto", () => {
		expect(devPrStateFrom({ state: "closed", merged: true })).toBe("merged");
		expect(devPrStateFrom({ state: "closed" })).toBe("closed");
		expect(devPrStateFrom({ state: "open", draft: true })).toBe("draft");
		expect(devPrStateFrom({ state: "open" })).toBe("open");
		expect(devPrStateFrom({ state: "closed", draft: true })).toBe("closed");
	});
	it("referência: número, #número e URL do GitHub; nada de outros hosts", () => {
		expect(parsePrReference("42")).toEqual({ number: 42 });
		expect(parsePrReference(" #42 ")).toEqual({ number: 42 });
		expect(parsePrReference("https://github.com/octo/hello/pull/42")).toEqual({ number: 42, repo: "octo/hello" });
		expect(parsePrReference("https://github.com/octo/hello/pull/42/files?x=1#a")).toEqual({ number: 42, repo: "octo/hello" });
		expect(parsePrReference("https://gitlab.com/octo/hello/pull/42")).toBeNull();
		expect(parsePrReference("https://github.com/octo/hello/issues/42")).toBeNull();
		expect(parsePrReference("abc")).toBeNull();
		expect(parsePrReference("")).toBeNull();
	});
	it("dev_pr e dev_ci são eventos de sessão e entram no histórico", () => {
		expect(DEV_SESSION_EVENT_TYPES).toContain("dev_pr");
		expect(DEV_SESSION_EVENT_TYPES).toContain("dev_ci");
		expect(DEV_HISTORY_EVENT_TYPES).toContain("dev_ci");
		expect(isDevSessionEvent({ type: "dev_pr" })).toBe(true);
	});
});
