import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatPolicy, setup } from "../testing/contract-helpers.js";
import { grantApproval, payloadHashOf } from "./approval.js";
import { createExecutor } from "./executor.js";
import { defineTool } from "../tools/define-tool.js";
import { sha256 } from "../testing/fake-ports.js";

const autonomous = { ...chatPolicy, autonomy: "autonomous" as const };

function noteTool(counter = { runs: 0 }, withReceipt = true) {
	const tool = defineTool({
		name: "save_event",
		description: "Create an event.",
		inputSchema: z.object({ title: z.string() }),
		effect: "write_external",
		execute: ({ title }) => {
			counter.runs++;
			return withReceipt
				? { ok: true, summary: `created ${title}`, receipt: { what: "Evento criado", where: "Agenda", externalId: "ev-9", url: "https://exemplo.test/ev-9" } }
				: { ok: true, summary: `created ${title}` };
		},
	});
	return { tool, counter };
}

describe("journal de efeitos e recibos (F1.6)", () => {
	it("efeito grava started antes e succeeded depois, com chave runId+call+hash e sem argumentos crus", async () => {
		const { executor, journal } = setup(autonomous);
		const { tool } = noteTool();
		await executor.executeCall({ callId: "c1", step: 3, tool, args: { title: "segredo-no-titulo" } });
		expect(journal.entries.map((e) => e.outcome)).toEqual(["started", "succeeded"]);
		const [first] = journal.entries;
		expect(first?.idempotencyKey).toBe(`run-1:s3:c1:${first?.argsHash}`);
		expect(first).toMatchObject({ userId: "owner-1", step: 3, toolName: "save_event" });
		expect(JSON.stringify(journal.entries)).not.toContain("segredo-no-titulo");
	});

	it("leitura não usa journal nem recibo", async () => {
		const { executor, journal, receipts } = setup();
		const read = defineTool({ name: "list_events", description: "List.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: true, summary: "0 events" }) });
		expect((await executor.executeCall({ callId: "c", step: 1, tool: read, args: {} })).status).toBe("ok");
		expect(journal.entries).toEqual([]);
		expect(receipts.items).toEqual([]);
	});

	it("depois do sucesso o recibo (o quê, onde, id externo, link) vai para Store.receipts", async () => {
		const { executor, receipts } = setup(autonomous);
		const out = await executor.executeCall({ callId: "c1", step: 1, tool: noteTool().tool, args: { title: "x" } });
		expect(out).toMatchObject({ status: "ok", receipt: { externalId: "ev-9" } });
		expect(receipts.items).toEqual([expect.objectContaining({ runId: "run-1", userId: "owner-1", toolName: "save_event", effect: "write_external", summary: "Evento criado", where: "Agenda", externalId: "ev-9", url: "https://exemplo.test/ev-9" })]);
	});

	it("efeito sem recibo é erro de contrato (nunca sucesso) e não deixa repetir às cegas", async () => {
		const { executor, journal, receipts } = setup(autonomous);
		const { tool, counter } = noteTool({ runs: 0 }, false);
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } });
		expect(out).toMatchObject({ status: "contract_error", error: expect.stringContaining("no receipt") });
		expect(receipts.items).toEqual([]);
		expect(journal.entries.at(-1)?.outcome).toBe("succeeded");
		expect((await executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } })).status).toBe("already_done");
		expect(counter.runs).toBe(1);
	});

	it("falha da tool grava failed e permite nova tentativa", async () => {
		const { executor, journal } = setup(autonomous);
		let n = 0;
		const tool = defineTool({ name: "save_event", description: "Create.", inputSchema: z.object({}), effect: "write_external", execute: () => (++n === 1 ? { ok: false, error: "503" } : { ok: true, summary: "ok", receipt: { what: "Criado" } }) });
		expect((await executor.executeCall({ callId: "c", step: 1, tool, args: {} })).status).toBe("error");
		expect(journal.entries.map((e) => e.outcome)).toEqual(["started", "failed"]);
		expect((await executor.executeCall({ callId: "c", step: 1, tool, args: {} })).status).toBe("ok");
	});

	it("retomada: started sem finished NÃO reexecuta; devolve interrupted_write honesto", async () => {
		const { tool, counter } = noteTool();
		const args = { title: "x" };
		const resumed = setup(autonomous);
		// o processo caiu depois de gravar `started` e antes de `succeeded`
		const key = `run-1:s1:c1:${payloadHashOf("save_event", args, sha256)}`;
		await resumed.journal.append({ runId: "run-1", userId: "owner-1", step: 1, idempotencyKey: key, toolName: "save_event", argsHash: "h", outcome: "started" });
		const out = await resumed.executor.executeCall({ callId: "c1", step: 1, tool, args });
		expect(out).toMatchObject({ status: "interrupted_write", hint: expect.stringContaining("Do not repeat it blindly") });
		expect(counter.runs).toBe(0);
		expect(resumed.receipts.items).toEqual([]);
	});

	it("retomada: succeeded vira already_done; outro dono não enxerga o journal", async () => {
		const a = setup(autonomous);
		const { tool, counter } = noteTool();
		await a.executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } });
		const again = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: a.ports, hash: sha256, policy: autonomous });
		expect((await again.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } })).status).toBe("already_done");
		const other = createExecutor({ runId: "run-1", ownerId: "owner-2", ports: a.ports, hash: sha256, policy: autonomous });
		expect((await other.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } })).status).toBe("ok");
		expect(counter.runs).toBe(2);
	});

	it("argumentos diferentes na mesma chamada têm outra chave (não confunde com a anterior)", async () => {
		const { executor } = setup(autonomous);
		const { tool, counter } = noteTool();
		await executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "a" } });
		await executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "b" } });
		expect(counter.runs).toBe(2);
	});

	it("aprovação pendente não grava journal; o grant gasto grava started/succeeded", async () => {
		const { executor, journal } = setup();
		const { tool } = noteTool();
		const out = await executor.executeCall({ callId: "c", step: 1, tool, args: { title: "x" } });
		expect(out.status).toBe("pending_approval");
		expect(journal.entries).toEqual([]);
	});

	it("S5: claim perdido (outro processo já tem a escrita) não executa: already_in_progress", async () => {
		const { executor, journal } = setup(autonomous);
		const { tool, counter } = noteTool();
		const args = { title: "x" };
		await journal.append({ runId: "run-1", userId: "owner-1", step: 1, idempotencyKey: `run-1:c1:${payloadHashOf("save_event", args, sha256)}`, toolName: "save_event", argsHash: "h", outcome: "started" });
		// corrida: o `find` do executor ainda não viu a entrada, mas o claim atômico do journal vê
		const find = journal.find.bind(journal);
		journal.find = async () => null;
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args });
		journal.find = find;
		expect(out).toMatchObject({ status: "already_in_progress", hint: expect.stringContaining("Do not repeat it") });
		expect(counter.runs).toBe(0);
		expect(journal.entries).toHaveLength(1);
	});

	it("S5: duas execuções concorrentes da mesma chamada rodam o efeito uma vez só", async () => {
		const a = setup(autonomous);
		const b = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: a.ports, hash: sha256, policy: autonomous });
		const { tool, counter } = noteTool();
		const [x, y] = await Promise.all([a.executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } }), b.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } })]);
		expect(counter.runs).toBe(1);
		expect([x.status, y.status].sort()).toContain("ok");
	});

	it("S5: sem lease vigente (worker zumbi) o efeito não roda nem é reivindicado", async () => {
		const { executor, journal, runs } = setup(autonomous);
		const { tool, counter } = noteTool();
		runs.leaseHeld = false;
		await expect(executor.executeCall({ callId: "c1", step: 1, tool, args: { title: "x" } })).rejects.toThrow("lease_lost");
		expect(counter.runs).toBe(0);
		expect(journal.entries).toEqual([]);
		// leitura não depende de lease
		const read = defineTool({ name: "list_events", description: "List.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: true, summary: "0" }) });
		expect((await executor.executeCall({ callId: "r", step: 1, tool: read, args: {} })).status).toBe("ok");
	});

	it("S5: efeito que falhou com grant não roda de novo com o mesmo grant, nem em processo novo", async () => {
		const first = setup();
		let n = 0;
		const tool = defineTool({
			name: "pay_bill",
			description: "Pay.",
			inputSchema: z.object({}),
			effect: "send",
			execute: () => (++n === 1 ? { ok: false, error: "503" } : { ok: true, summary: "ok", receipt: { what: "Pago" } }),
		});
		const pending = await first.executor.executeCall({ callId: "c", step: 1, tool, args: {} });
		if (pending.status !== "pending_approval") throw new Error("unreachable");
		const grant = grantApproval(pending.request, first.clock.now());
		expect((await first.executor.executeCall({ callId: "c", step: 1, tool, args: {}, grant })).status).toBe("error");
		// processo novo: `consumed` vazio, journal compartilhado
		const second = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: first.ports, hash: sha256, policy: chatPolicy });
		expect(await second.executeCall({ callId: "c", step: 1, tool, args: {}, grant })).toMatchObject({ status: "approval_invalid", reason: "approval already used" });
		expect(n).toBe(1);
	});
});
