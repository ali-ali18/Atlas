import { describe, expect, it } from "vitest";
import { z } from "zod";
import { grantApproval, type ApprovalRequest } from "../contract/index.js";
import { chatPolicy, sendTool } from "../testing/contract-helpers.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { defineTool } from "../tools/define-tool.js";
import { EXPIRED_TEXT } from "./tool-step.js";

const lookup = (counter = { runs: 0 }) =>
	defineTool({ name: "lookup", description: "Look something up.", inputSchema: z.object({ q: z.string() }), effect: "read", execute: ({ q }) => (counter.runs++, { ok: true, summary: `result for ${q}` }) });
const webRead = () =>
	defineTool({ name: "web_read", description: "Read a page.", inputSchema: z.object({ url: z.string() }), effect: "read", trust: "untrusted", source: "web", execute: () => ({ ok: true, summary: "page text from the web" }) });
const eventTool = (counter = { runs: 0 }) =>
	defineTool({ name: "create_event", description: "Create an event.", inputSchema: z.object({ title: z.string() }), effect: "write_external", execute: ({ title }) => (counter.runs++, { ok: true, summary: `created ${title}`, receipt: { what: "Evento criado", externalId: "ev-1" } }) });
const autonomous = { ...chatPolicy, autonomy: "autonomous" as const };

describe("kernel: laço", () => {
	it("resposta sem tool encerra o turno e o texto do modelo passa byte a byte", async () => {
		const text = "  Olá!\n\n<b>não mexa</b>  ç— com espaços no fim   ";
		const h = kernelHarness([reply({ chunks: [text.slice(0, 5), text.slice(5)] })]);
		const result = await h.run();
		expect(result).toMatchObject({ status: "done", text, steps: 0 });
		expect(h.log.of("text_delta").map((d) => d.text).join("")).toBe(text);
		expect(h.log.of("final")[0]?.text).toBe(text);
		expect(h.runs.statuses.get("owner-1:run-1")).toBe("done");
		expect(h.llm.requests).toHaveLength(1);
		expect(h.llm.requests[0]?.role).toBe("main");
	});

	it("conversa anterior (dono, assistente com tool e resultado) entra no pedido na ordem e o run segue", async () => {
		const h = kernelHarness([reply({ text: "de nada" })]);
		const history = [
			{ kind: "owner" as const, text: "quanto é 2+2?" },
			{ kind: "assistant" as const, text: "Vou calcular.", toolCalls: [{ id: "k1", name: "calc", args: { e: "2+2" } }] },
			{ kind: "data" as const, source: "tool:calc" as const, text: "4", toolCallId: "k1" },
			{ kind: "assistant" as const, text: "É 4." },
			{ kind: "owner" as const, text: "valeu" },
		];
		const result = await h.run({ input: { ...h.input, history } });
		expect(result).toMatchObject({ status: "done", text: "de nada" });
		expect(h.llm.requests[0]?.messages.slice(2).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
	});

	it("laço de tool: resultado volta como dado do canal, o histórico só cresce e o checkpoint segue por passo", async () => {
		const c = { runs: 0 };
		const h = kernelHarness([reply({ calls: [call("c1", "lookup", { q: "a" })] }), reply({ text: "pronto" })], { tools: [lookup(c)] });
		const result = await h.run();
		expect(result.status).toBe("done");
		expect(c.runs).toBe(1);
		const [first, second] = h.llm.requests;
		const tail = second?.messages.at(-1);
		expect(tail).toMatchObject({ role: "tool", toolCallId: "c1" });
		expect((tail as { content: string }).content).toContain('<data source="tool:lookup" trust="untrusted">');
		expect((tail as { content: string }).content).toContain("result for a");
		// 3 blocos e prefixo idêntico entre passos (só acréscimo)
		expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
		expect(first?.tools?.map((t) => t.name)).toContain("lookup");
		expect(h.log.of("tool_call")[0]).toMatchObject({ callId: "c1", name: "lookup" });
		expect(h.log.of("tool_result")[0]).toMatchObject({ callId: "c1", status: "ok" });
		expect(h.runs.checkpoints.get("owner-1:run-1")?.state).toBe("DONE");
	});

	it("leituras rodam em paralelo; efeitos em série e na ordem", async () => {
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let started = 0;
		const slow = defineTool({
			name: "slow_read",
			description: "Slow read.",
			inputSchema: z.object({ n: z.number() }),
			effect: "read",
			execute: async ({ n }) => {
				started++;
				if (started === 2) release();
				await gate;
				order.push(`read${n}`);
				return { ok: true, summary: `r${n}` };
			},
		});
		const note = (n: string) => defineTool({ name: `write_${n}`, description: "Write.", inputSchema: z.object({}), effect: "write_internal", execute: () => (order.push(`write_${n}`), { ok: true, summary: "ok", receipt: { what: "w" } }) });
		const h = kernelHarness(
			[reply({ calls: [call("a", "slow_read", { n: 1 }), call("b", "slow_read", { n: 2 }), call("c", "write_a", {}), call("d", "write_b", {})] }), reply({ text: "ok" })],
			{ tools: [slow, note("a"), note("b")] },
		);
		const result = await h.run({ policy: autonomous });
		expect(result.status).toBe("done");
		expect(order.slice(2)).toEqual(["write_a", "write_b"]);
		const toolMsgs = h.llm.requests[1]?.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId);
		expect(toolMsgs).toEqual(["a", "b", "c", "d"]);
	});
});

describe("kernel: aprovação e handoff", () => {
	it("pending_approval estaciona com o cartão; a retomada com o grant executa uma vez", async () => {
		const { tool, counter } = sendTool();
		const h = kernelHarness([reply({ calls: [call("s1", "send_email", { to: "a@example.com", body: "oi" })] }), reply({ text: "enviei" })], { tools: [tool] });
		const first = await h.run();
		expect(first.status).toBe("parked");
		expect(counter.runs).toBe(0);
		expect(h.runs.statuses.get("owner-1:run-1")).toBe("parked");
		const card = h.log.of("card")[0] as { kind: string; request: ApprovalRequest };
		expect(card.kind).toBe("approval");
		// retomar sem decisão não executa nem repete o cartão
		expect((await h.run()).status).toBe("parked");
		expect(h.log.of("card")).toHaveLength(1);
		const resumed = await h.run({ input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(resumed).toMatchObject({ status: "done", text: "enviei" });
		expect(counter.runs).toBe(1);
		expect(h.receipts.items).toHaveLength(1);
	});

	it("chamada estacionada segura as seguintes: efeito posterior não passa na frente da aprovação (B9)", async () => {
		const order: string[] = [];
		const send = defineTool({ name: "send_email", description: "Send.", inputSchema: z.object({ to: z.string() }), effect: "send", riskFacts: ({ to }) => ({ recipients: [to], externalRecipients: [to], irreversible: true }), execute: ({ to }) => (order.push(`send:${to}`), { ok: true, summary: "sent", receipt: { what: "enviado", externalId: "m" } }) });
		const event = defineTool({ name: "create_event", description: "Event.", inputSchema: z.object({ title: z.string() }), effect: "write_external", execute: ({ title }) => (order.push(`event:${title}`), { ok: true, summary: "created", receipt: { what: "evento", externalId: "e" } }) });
		const h = kernelHarness([reply({ calls: [call("s1", "send_email", { to: "a@example.com" }), call("e1", "create_event", { title: "x" }), call("e2", "create_event", { title: "y" })] }), reply({ text: "ok" })], { tools: [send, event] });
		expect((await h.run({ policy: autonomous })).status).toBe("parked");
		expect(order).toEqual([]);
		expect(h.log.of("tool_call").map((c) => c.callId)).toEqual(["s1"]);
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		const done = await h.run({ policy: autonomous, input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(done.status).toBe("done");
		expect(order).toEqual(["send:a@example.com", "event:x", "event:y"]);
		expect(h.llm.requests[1]?.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["s1", "e1", "e2"]);
	});

	it("provedor que repete o id da chamada no mesmo passo: cada chamada ganha seu resultado (B12)", async () => {
		const c = { runs: 0 };
		const h = kernelHarness([reply({ calls: [call("call_0", "lookup", { q: "a" }), call("call_0", "lookup", { q: "b" })] }), reply({ text: "ok" })], { tools: [lookup(c)] });
		await h.run();
		const msgs = h.llm.requests[1]?.messages ?? [];
		const ids = msgs.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId);
		expect(ids).toEqual(["call_0", "call_0_2"]);
		expect(JSON.stringify(msgs.find((m) => m.role === "tool" && (m as { toolCallId: string }).toolCallId === "call_0_2"))).toContain("result for b");
		expect(msgs.find((m) => m.role === "assistant" && "toolCalls" in m && m.toolCalls)).toMatchObject({ toolCalls: [{ id: "call_0" }, { id: "call_0_2" }] });
	});

	it("NUL e substituto solto na saída da tool viram U+FFFD antes do checkpoint (B11)", async () => {
		const dirty = defineTool({ name: "dirty", description: "Dirty.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: true, summary: "a\u0000b\ud800c ç😀" }) });
		const h = kernelHarness([reply({ calls: [call("d1", "dirty", {})] }), reply({ text: "ok" })], { tools: [dirty] });
		await h.run();
		const content = h.log.of("tool_result")[0]?.content as string;
		expect(content).toBe("a\uFFFDb\uFFFDc ç😀");
		expect(JSON.stringify(h.runs.checkpoints.get("owner-1:run-1")?.payload)).not.toContain("\\u0000");
	});

	it("recusa do dono volta ao modelo como dado e nada executa", async () => {
		const { tool, counter } = sendTool();
		const h = kernelHarness([reply({ calls: [call("s1", "send_email", { to: "a@example.com", body: "oi" })] }), reply({ text: "ok, não envio" })], { tools: [tool] });
		await h.run();
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		const out = await h.run({ input: { ...h.input, resume: { denied: [card.request.id] } } });
		expect(out.status).toBe("done");
		expect(counter.runs).toBe(0);
		expect(JSON.stringify(h.llm.requests.at(-1)?.messages)).toContain("owner declined");
	});

	it("pedido expirado volta ao modelo como dado, nada executa e o run segue", async () => {
		const { tool, counter } = sendTool();
		const h = kernelHarness([reply({ calls: [call("s1", "send_email", { to: "a@example.com", body: "oi" })] }), reply({ text: "ok, deixo para depois" })], { tools: [tool] });
		await h.run();
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		const out = await h.run({ input: { ...h.input, resume: { expired: [card.request.id] } } });
		expect(out.status).toBe("done");
		expect(counter.runs).toBe(0);
		expect(JSON.stringify(h.llm.requests.at(-1)?.messages)).toContain(EXPIRED_TEXT);
		expect(h.log.of("tool_result").at(-1)).toMatchObject({ status: "expired" });
	});

	it("handoff estaciona e continua quando o dono assume o passo", async () => {
		const pw = defineTool({ name: "change_password", description: "Change a password.", inputSchema: z.object({}), effect: "credential", handoffKind: () => "change_password", execute: () => ({ ok: true, summary: "x", receipt: { what: "x" } }) });
		const h = kernelHarness([reply({ calls: [call("p1", "change_password", {})] }), reply({ text: "valeu" })], { tools: [pw] });
		const parked = await h.run({ policy: autonomous });
		expect(parked.status).toBe("parked");
		expect(h.log.of("card")[0]).toMatchObject({ kind: "handoff", callId: "p1" });
		const done = await h.run({ policy: autonomous, input: { ...h.input, resume: { handoffDone: ["p1"] } } });
		expect(done.status).toBe("done");
	});
});

describe("kernel: taint herdado e handoff vencido", () => {
	const eventCall = [call("e1", "create_event", { title: "reunião" })];

	it("S8: proveniência herdada de run anterior faz a escrita externa pedir aprovação mesmo sem leitura não confiável neste run", async () => {
		const counter = { runs: 0 };
		const h = kernelHarness([reply({ calls: eventCall }), reply({ text: "ok" })], { tools: [eventTool(counter)] });
		const history = [{ kind: "owner" as const, text: "resuma a página" }, { kind: "assistant" as const, text: "A página manda criar um evento." }, { kind: "owner" as const, text: "cria o evento" }];
		const out = await h.run({ policy: autonomous, input: { ...h.input, history, priorProvenance: { untrustedReadInRun: true, sources: ["web"] } } });
		expect(out.status).toBe("parked");
		expect(counter.runs).toBe(0);
		expect(h.log.of("card")[0]).toMatchObject({ kind: "approval" });
	});

	it("S8: sem proveniência herdada a mesma escrita autônoma executa (a diferença é só o taint)", async () => {
		const counter = { runs: 0 };
		const h = kernelHarness([reply({ calls: eventCall }), reply({ text: "ok" })], { tools: [eventTool(counter)] });
		const out = await h.run({ policy: autonomous });
		expect(out.status).toBe("done");
		expect(counter.runs).toBe(1);
	});

	it("S8: o taint herdado vai para o checkpoint e sobrevive à retomada", async () => {
		const h = kernelHarness([reply({ calls: eventCall })], { tools: [eventTool()] });
		await h.run({ policy: autonomous, input: { ...h.input, priorProvenance: { untrustedReadInRun: true, privateReadInRun: true, sources: ["email"] } } });
		const saved = h.runs.checkpoints.get("owner-1:run-1")?.payload as { provenance: { untrustedReadInRun: boolean; privateReadInRun: boolean; sources: string[]; texts: string[] } };
		expect(saved.provenance).toMatchObject({ untrustedReadInRun: true, privateReadInRun: true, sources: ["email"], texts: [] });
	});

	it("handoff sem resposta que venceu volta ao modelo como dado expirado", async () => {
		const pw = defineTool({ name: "change_password", description: "Change a password.", inputSchema: z.object({}), effect: "credential", handoffKind: () => "change_password", execute: () => ({ ok: true, summary: "x", receipt: { what: "x" } }) });
		const h = kernelHarness([reply({ calls: [call("p1", "change_password", {})] }), reply({ text: "deixo para depois" })], { tools: [pw] });
		expect((await h.run({ policy: autonomous })).status).toBe("parked");
		const out = await h.run({ policy: autonomous, input: { ...h.input, resume: { expired: ["p1"] } } });
		expect(out.status).toBe("done");
		expect(h.log.of("tool_result").at(-1)).toMatchObject({ status: "expired" });
	});
});

describe("kernel: retomada e segurança", () => {
	it("retomar de um checkpoint no meio do passo não repete o efeito (journal)", async () => {
		const counter = { runs: 0 };
		const tool = eventTool(counter);
		const h = kernelHarness([reply({ calls: [call("s1", "create_event", { title: "x" })] }), reply({ text: "feito" })], { tools: [tool] });
		h.runs.crashOnSave = 3; // morre ao salvar depois de executar as tools (SETTLE)
		const crashed = await h.run({ policy: autonomous });
		expect(crashed).toMatchObject({ status: "failed", reason: "kernel_error" });
		expect(counter.runs).toBe(1);
		expect(h.runs.checkpoints.get("owner-1:run-1")?.state).toBe("TOOLS");
		const resumed = await h.run({ policy: autonomous });
		expect(resumed).toMatchObject({ status: "done", text: "feito" });
		expect(counter.runs).toBe(1);
		expect(h.journal.entries.filter((e) => e.outcome === "succeeded")).toHaveLength(1);
		expect(JSON.stringify(h.llm.requests.at(-1)?.messages)).toContain("already finished");
	});

	it("a proveniência sobrevive à retomada: o taint continua valendo depois do checkpoint", async () => {
		const counter = { runs: 0 };
		const tool = eventTool(counter);
		const turns = () => [reply({ calls: [call("w1", "web_read", { url: "https://example.com" })] }), reply({ calls: [call("s1", "create_event", { title: "x" })] })];
		const h = kernelHarness(turns(), { tools: [webRead(), tool] });
		h.runs.crashOnSave = 4; // cai ao salvar o TOOLS do efeito; o último checkpoint (SETTLE→PREPARE) tem o taint da leitura
		expect((await h.run({ policy: autonomous })).status).toBe("failed");
		h.llm.push(reply({ calls: [call("s1", "create_event", { title: "x" })] }));
		const resumed = await h.run({ policy: autonomous });
		expect(resumed.status).toBe("parked");
		expect(counter.runs).toBe(0);
		// controle: sem leitura não confiável o mesmo envio roda direto
		const control = kernelHarness([reply({ calls: [call("s1", "create_event", { title: "x" })] }), reply({ text: "ok" })], { tools: [eventTool(counter)] });
		expect((await control.run({ policy: autonomous })).status).toBe("done");
		expect(counter.runs).toBe(1);
	});

	it("checkpoint: 2 gravações por passo com tools (não 3), sem clone do snapshot, e a retomada continua correta (C1)", async () => {
		const refs: unknown[] = [];
		const h = kernelHarness([reply({ calls: [call("a", "lookup", { q: "1" })] }), reply({ calls: [call("b", "lookup", { q: "2" })] }), reply({ text: "fim" })], { tools: [lookup()] });
		const original = h.runs.saveCheckpoint.bind(h.runs);
		h.runs.saveCheckpoint = async (c) => (refs.push(c.payload), original(c));
		await h.run();
		// inicial + (modelo→tools, tools→próximo) × 2 passos + DONE
		expect(h.runs.saves).toBe(6);
		expect(new Set(refs).size).toBe(1); // sempre o objeto vivo: nenhuma cópia por gravação
		// queda ao gravar o DONE: a retomada parte do checkpoint do SETTLE, conclui e não repete a leitura do passo 1
		const c = { runs: 0 };
		const r = kernelHarness([reply({ calls: [call("a", "lookup", { q: "1" })] }), reply({ text: "fim" })], { tools: [lookup(c)] });
		r.runs.crashOnSave = 4; // inicial, modelo→tools, tools→próximo, DONE
		expect((await r.run()).status).toBe("failed");
		r.llm.push(reply({ text: "fim" }));
		expect(await r.run()).toMatchObject({ status: "done", text: "fim" });
		expect(c.runs).toBe(1);
	});

	it("run terminado devolve o resultado guardado sem chamar o modelo de novo", async () => {
		const h = kernelHarness([reply({ text: "oi" })]);
		const a = await h.run();
		const b = await h.run();
		expect(b).toEqual(a);
		expect(h.llm.requests).toHaveLength(1);
	});

	it("use_capability acrescenta tools no fim e o checkpoint lembra o que foi carregado", async () => {
		const { defineCapability } = await import("../capabilities/define-capability.js");
		const core = defineCapability({ id: "core", title: "Core", summary: "core", core: true, tools: [lookup()] });
		const extra = defineCapability({ id: "extra", title: "Extra", summary: "extra", tools: [webRead()] });
		const h = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "extra" })] }), reply({ text: "ok" })], { capabilities: [core, extra] });
		await h.run();
		const [a, b] = h.llm.requests.map((r) => r.tools?.map((t) => t.name));
		expect(b?.slice(0, a?.length)).toEqual(a);
		expect(b?.at(-1)).toBe("web_read");
		expect((h.runs.checkpoints.get("owner-1:run-1")?.payload as { loadedIds: string[] }).loadedIds).toEqual(["core", "extra"]);
	});

	it("lease_lost / dono trocado no checkpoint sobe sem virar kernel_error nem marcar o run como failed (B2)", async () => {
		for (const error of [new Error("lease_lost"), Object.assign(new Error("Recurso não encontrado"), { name: "ResourceOwnershipError", code: "RESOURCE_NOT_FOUND" })]) {
			const h = kernelHarness([reply({ text: "oi" })]);
			h.runs.crashOnSave = 2;
			h.runs.crashError = error;
			await expect(h.run()).rejects.toBe(error);
			expect(h.runs.statuses.get("owner-1:run-1")).toBe("running");
			expect(h.log.of("status").some((s) => s.reason === "kernel_error")).toBe(false);
		}
	});

	it("outro erro do checkpoint continua kernel_error e o RunResult guarda a mensagem original (B2)", async () => {
		const h = kernelHarness([reply({ text: "oi" })]);
		h.runs.crashOnSave = 2;
		const out = await h.run();
		expect(out).toMatchObject({ status: "failed", reason: "kernel_error", error: "crash simulado" });
	});

	it("falha no meio do stream sem preço não zera o custo conhecido do passo (B7/C6)", async () => {
		const h = kernelHarness([reply({ chunks: ["parc"], finish: "error", usage: { costUsd: undefined } }), reply({ text: "ok", usage: { costUsd: 0.05 } })]);
		const out = await h.run();
		expect(out).toMatchObject({ status: "done", text: "ok" });
		expect(out.spentUsd).toBeCloseTo(0.05);
		const g = kernelHarness([reply({ finish: "error", usage: { costUsd: 0.02 } }), reply({ text: "ok", usage: { costUsd: undefined } })]);
		expect((await g.run()).spentUsd).toBeCloseTo(0.02);
		expect((g.runs.checkpoints.get("owner-1:run-1")?.payload as { stepsWithoutPrice: number }).stepsWithoutPrice).toBe(1);
	});

	it("resposta vazia seguida de erro com texto parcial é model_error, não sucesso (B8)", async () => {
		const h = kernelHarness([reply({}), reply({ chunks: ["meio da fra"], finish: "error" })]);
		const out = await h.run();
		expect(out).toMatchObject({ status: "failed", reason: "model_error" });
		expect(h.runs.statuses.get("owner-1:run-1")).toBe("failed");
	});
});
