import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatPolicy, sendTool, setup } from "../testing/contract-helpers.js";
import { sha256 } from "../testing/fake-ports.js";
import { defineTool } from "../tools/define-tool.js";
import { grantApproval, requestApproval } from "./approval.js";

describe("aprovação presa aos argumentos (F1.4)", () => {
	it("verdict approve devolve pending_approval com cartão estruturado e NÃO executa", async () => {
		const { executor } = setup();
		const { tool, counter } = sendTool();
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args: { to: "ana@exemplo.test", body: "oi" } });
		expect(out.status).toBe("pending_approval");
		if (out.status !== "pending_approval") throw new Error("unreachable");
		expect(counter.runs).toBe(0);
		expect(out.request).toMatchObject({ toolName: "send_email", effect: "send", args: { to: "ana@exemplo.test", body: "oi" }, riskFacts: { recipients: ["ana@exemplo.test"], irreversible: true } });
		expect(out.request.payloadHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("com grant do hash atual executa; o resultado traz o recibo", async () => {
		const { executor, clock } = setup();
		const { tool, counter } = sendTool();
		const args = { to: "ana@exemplo.test", body: "oi" };
		const pending = await executor.executeCall({ callId: "c1", step: 1, tool, args });
		if (pending.status !== "pending_approval") throw new Error("unreachable");
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args, grant: grantApproval(pending.request, clock.now()) });
		expect(out).toMatchObject({ status: "ok", summary: "sent to ana@exemplo.test" });
		expect(counter.runs).toBe(1);
	});

	it("qualquer mudança de argumento invalida o grant", async () => {
		const { executor, clock } = setup();
		const { tool, counter } = sendTool();
		const pending = await executor.executeCall({ callId: "c1", step: 1, tool, args: { to: "ana@exemplo.test", body: "oi" } });
		if (pending.status !== "pending_approval") throw new Error("unreachable");
		const grant = grantApproval(pending.request, clock.now());
		for (const changed of [{ to: "evil@exemplo.test", body: "oi" }, { to: "ana@exemplo.test", body: "oi!" }]) {
			const out = await executor.executeCall({ callId: "c1", step: 1, tool, args: changed, grant });
			expect(out.status).toBe("approval_invalid");
		}
		expect(counter.runs).toBe(0);
	});

	it("grant forjado (hash certo, pedido de outra chamada ou hash errado) não passa", async () => {
		const { executor, clock } = setup();
		const { tool, counter } = sendTool();
		const args = { to: "ana@exemplo.test", body: "oi" };
		const pending = await executor.executeCall({ callId: "c1", step: 1, tool, args });
		if (pending.status !== "pending_approval") throw new Error("unreachable");
		const grant = grantApproval(pending.request, clock.now());
		expect((await executor.executeCall({ callId: "c2", step: 1, tool, args, grant })).status).toBe("approval_invalid");
		expect((await executor.executeCall({ callId: "c1", step: 1, tool, args, grant: { ...grant, payloadHash: "0".repeat(64) } })).status).toBe("approval_invalid");
		expect(counter.runs).toBe(0);
	});

	it("o grant é de uso único", async () => {
		const { executor, clock } = setup();
		const { tool, counter } = sendTool();
		const args = { to: "ana@exemplo.test", body: "oi" };
		const pending = await executor.executeCall({ callId: "c1", step: 1, tool, args });
		if (pending.status !== "pending_approval") throw new Error("unreachable");
		const grant = grantApproval(pending.request, clock.now());
		expect((await executor.executeCall({ callId: "c1", step: 1, tool, args, grant })).status).toBe("ok");
		const again = await executor.executeCall({ callId: "c1", step: 1, tool, args, grant });
		expect(again).toMatchObject({ status: "approval_invalid", reason: "approval already used" });
		expect(counter.runs).toBe(1);
	});

	it("o cartão não carrega segredo e o id é estável para a mesma chamada", () => {
		const token = ["gh", "p_"].join("") + "a".repeat(30);
		const input = { runId: "r", callId: "c", toolName: "send_email", effect: "send" as const, args: { to: "a@exemplo.test", body: `chave ${token}` }, hash: sha256 };
		const a = requestApproval(input);
		expect(JSON.stringify(a)).not.toContain(token);
		expect(requestApproval(input).id).toBe(a.id);
		expect(requestApproval({ ...input, callId: "d" }).id).not.toBe(a.id);
	});
});

describe("handoff, hidden e erros", () => {
	it("handoff e hidden não rodam e dizem o que é possível, sem internals no texto do dono", async () => {
		const { tool, counter } = sendTool();
		const hidden = await setup({ ...chatPolicy, surface: "agenda", ownerPresent: false }).executor.executeCall({ callId: "c", step: 1, tool, args: { to: "a@exemplo.test", body: "x" } });
		expect(hidden).toMatchObject({ status: "not_available", message: expect.stringContaining("offer what is possible") });
		const denied = await setup({ ...chatPolicy, rules: [{ match: "send_*", verdict: "deny" }] }).executor.executeCall({ callId: "c", step: 1, tool, args: { to: "a@exemplo.test", body: "x" } });
		expect(denied.status).toBe("not_available");
		if (hidden.status === "not_available") expect(hidden.userMessage).not.toMatch(/send_email|tool|ferramenta/i);

		const pwd = defineTool({ name: "change_pw", description: "Change a password.", inputSchema: z.object({}), effect: "credential", handoffKind: () => "change_password", execute: () => ({ ok: true, summary: "x" }) });
		const out = await setup().executor.executeCall({ callId: "c", step: 1, tool: pwd, args: {} });
		expect(out.status).toBe("handoff");
		expect(counter.runs).toBe(0);
	});

	it("erro da tool passa por redação de segredo antes de chegar ao modelo", async () => {
		const token = ["gh", "p_"].join("") + "b".repeat(30);
		const tool = defineTool({ name: "read_repo", description: "Read a repo.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: false, error: `401 with ${token}`, hint: `Bearer ${"z".repeat(20)}` }) });
		const out = await setup().executor.executeCall({ callId: "c", step: 1, tool, args: {} });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).not.toContain(token);
		expect(JSON.stringify(out)).not.toContain("z".repeat(20));
	});

	it("segredo conhecido do cofre é redigido mesmo sem padrão reconhecível", async () => {
		const tool = defineTool({ name: "read_repo", description: "Read a repo.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: false, error: "login failed for hunter2-pass" }) });
		const out = await setup(chatPolicy, { secrets: () => ["hunter2-pass"] }).executor.executeCall({ callId: "c", step: 1, tool, args: {} });
		expect(out).toMatchObject({ status: "error", error: "login failed for [redacted]" });
	});
});
