import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createVaultAdapter, trackVault } from "../../index.js";
import { createExecutor, grantApproval, type ExecutorDeps } from "../../contract/index.js";
import type { Ports } from "../../ports/index.js";
import type { Sandbox, SandboxAction, SandboxResult } from "../../ports/sandbox.js";
import { defineTool } from "../../tools/define-tool.js";
import { chatPolicy } from "../../testing/contract-helpers.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import { FakeSecretRequests, FakeVault, type FakeVaultItem, TEST_LOGIN_PASSWORD, TEST_SECRET_VALUE } from "../../testing/vault-fakes.js";
import { createVaultCapability, VAULT_KINDS } from "./index.js";

const ITEMS: FakeVaultItem[] = [
	{ owner: "owner-1", id: "stripe-key", kind: "secret", value: TEST_SECRET_VALUE, description: "Stripe live key" },
	{ owner: "owner-1", id: "banco", label: "Banco do Dono", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco.example", username: "dono@exemplo.test" },
	{ owner: "owner-1", id: "sem-site", kind: "login", password: TEST_LOGIN_PASSWORD, username: "x" },
	{ owner: "owner-2", id: "chave-do-b", kind: "secret", value: "valor-secreto-do-b-123" },
	{ owner: "owner-2", id: "stripe-key", kind: "secret", value: "outra-chave-do-b-456" },
];

class FakeVm implements Sandbox {
	readonly actions: Array<{ userId: string; action: SandboxAction }> = [];
	respond: (action: SandboxAction) => SandboxResult = () => ({ ok: true, data: { filled: ["username", "password"], site: "banco.example", submitted: false } });
	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.actions.push({ userId, action });
		return this.respond(action);
	}
	async release() {}
}

function rig(items: FakeVaultItem[] = ITEMS, opts: { readOnly?: boolean; policy?: ExecutorDeps["policy"]; ownerId?: string } = {}) {
	const backing = new FakeVault(items);
	const requests = new FakeSecretRequests();
	const vm = new FakeVm();
	const f = fakePorts();
	const tracked = trackVault(backing);
	const ports = { ...f.ports, vault: tracked.vault, sandbox: vm } as unknown as Ports;
	const capability = createVaultCapability({ vault: backing, requests, ...(opts.readOnly && { readOnly: true }) });
	const tool = (name: string) => {
		const found = capability.tools.find((t) => t.name === name);
		if (!found) throw new Error(`tool ${name} ausente`);
		return found;
	};
	const executor = createExecutor({ runId: "run-1", ownerId: opts.ownerId ?? "owner-1", ports, hash: sha256, policy: opts.policy ?? chatPolicy, secrets: tracked.secrets });
	return { backing, requests, vm, f, capability, tool, executor, tracked, ports };
}

describe("capacidade vault: oferta das tools", () => {
	it("com dono: secret_list, secret_request e login_fill; sem dono (readOnly): só secret_list", () => {
		expect(rig().capability.tools.map((t) => t.name)).toEqual(["secret_list", "secret_request", "login_fill"]);
		expect(rig(ITEMS, { readOnly: true }).capability.tools.map((t) => t.name)).toEqual(["secret_list"]);
	});

	it("sem o cartão de pedido, secret_request não é oferecida", () => {
		const capability = createVaultCapability({ vault: new FakeVault() });
		expect(capability.tools.map((t) => t.name)).toEqual(["secret_list", "login_fill"]);
	});

	it("o resumo cabe no índice e as instruções dizem que o modelo só vê nomes", () => {
		const { capability } = rig();
		expect(capability.id).toBe("vault");
		expect(capability.summary.length).toBeLessThanOrEqual(160);
		expect(capability.instructions).toContain("never values");
	});

	it("login_fill é credential; secret_list e secret_request são leituras", () => {
		const r = rig();
		expect(r.tool("login_fill").effect).toBe("credential");
		expect(r.tool("secret_list").effect).toBe("read");
		expect(r.tool("secret_request").effect).toBe("read");
		expect(r.tool("secret_request").endsTurn).toBe(true);
	});
});

describe("secret_list", () => {
	it("lista nomes, tipo, site e usuário, e NUNCA o valor nem a senha", async () => {
		const r = rig();
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_list"), args: {} });
		expect(out.status).toBe("ok");
		const text = JSON.stringify(out);
		expect(text).toContain("stripe-key");
		expect(text).toContain("banco.example");
		expect(text).toContain("dono@exemplo.test");
		expect(text).not.toContain(TEST_SECRET_VALUE);
		expect(text).not.toContain(TEST_LOGIN_PASSWORD);
		expect(r.backing.resolved).toEqual([]);
	});

	it("outro dono: só vê os próprios itens", async () => {
		const r = rig(ITEMS, { ownerId: "owner-2" });
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_list"), args: {} });
		const text = JSON.stringify(out);
		expect(text).toContain("chave-do-b");
		expect(text).not.toContain("banco.example");
		expect(text).not.toContain("Stripe live key");
	});

	it("cofre vazio diz como pedir, sem pedir para colar no chat", async () => {
		const r = rig([]);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_list"), args: {} });
		expect(out.status === "ok" && out.summary).toContain("secret_request");
	});

	it("campo desconhecido falha com a lista do aceito", async () => {
		const r = rig();
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_list"), args: { reveal: true } });
		expect(out.status).toBe("error");
	});
});

describe("secret_request", () => {
	it("pede só o que falta, com o dono do run, e encerra o turno", async () => {
		const r = rig();
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { names: ["stripe-key", "openai-key", "openai-key"], reason: "Preciso chamar a API." } });
		expect(out.status).toBe("ok");
		expect(r.requests.asks).toEqual([{ userId: "owner-1", runId: "run-1", request: { names: ["openai-key"], reason: "Preciso chamar a API." } }]);
	});

	it("o que já existe não gera cartão", async () => {
		const r = rig();
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { names: ["stripe-key"], reason: "x" } });
		expect(out.status === "ok" && out.summary).toContain("nothing was asked");
		expect(r.requests.asks).toHaveLength(0);
	});

	it("o segredo de OUTRO dono com o mesmo nome não conta como existente", async () => {
		const r = rig(ITEMS.filter((i) => i.id !== "stripe-key" || i.owner === "owner-2"));
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { names: ["stripe-key"], reason: "x" } });
		expect(out.status).toBe("ok");
		expect(r.requests.asks).toHaveLength(1);
	});

	it("nome inválido, lista vazia, excesso e campo desconhecido falham com o aceito", async () => {
		const r = rig();
		for (const args of [{ names: ["com espaço"], reason: "x" }, { names: [], reason: "x" }, { names: ["a", "b", "c", "d", "e", "f"], reason: "x" }, { names: ["a"] }, { names: ["a"], reason: "x", value: "oops" }]) {
			const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args });
			expect(out.status).toBe("error");
		}
		expect(r.requests.asks).toHaveLength(0);
	});

	it("falha ao mostrar o cartão é erro real, nunca sucesso", async () => {
		const r = rig();
		r.requests.failWith = "sem conversa para mostrar o cartão";
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { names: ["nova"], reason: "x" } });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("sem conversa");
	});
});

describe("login_fill", () => {
	const ARGS = { login: "banco", fields: [{ key: "username", ref: "e1" }, { key: "password", ref: "e2" }] };

	it("sempre pede o dono (cartão), mesmo em autonomia total, e o cartão mostra o site sem segredo", async () => {
		const r = rig(ITEMS, { policy: { ...chatPolicy, autonomy: "autonomous" } });
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: ARGS });
		if (out.status !== "pending_approval") throw new Error(out.status);
		expect(out.request.effect).toBe("credential");
		expect(out.request.riskFacts.target).toBe("Banco do Dono (banco.example)");
		expect(JSON.stringify(out.request)).not.toContain(TEST_LOGIN_PASSWORD);
		expect(r.vm.actions).toHaveLength(0);
	});

	it("sem dono presente a tool fica fora (não executa nem pede)", async () => {
		const r = rig(ITEMS, { policy: { surface: "routine", ownerPresent: false, autonomy: "balanced", rules: [] } });
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: ARGS });
		expect(out.status).toBe("not_available");
		expect(r.vm.actions).toHaveLength(0);
	});

	it("aprovado: leva SÓ o nome do login à VM (nunca senha nem usuário) e o resultado não tem segredo", async () => {
		const r = rig();
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: { ...ARGS, submit: true } });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		r.vm.respond = () => ({ ok: true, data: { filled: ["username", "password"], site: "banco.example", submitted: true, landedHost: "banco.example" } });
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: { ...ARGS, submit: true }, grant: grantApproval(pending.request, r.f.clock.now()) });
		expect(out.status).toBe("ok");
		expect(r.vm.actions).toEqual([{ userId: "owner-1", action: { kind: VAULT_KINDS.loginFill, params: { login: "banco", fields: ARGS.fields, submit: true } } }]);
		const all = JSON.stringify({ out, actions: r.vm.actions, receipts: r.f.receipts, journal: r.f.journal });
		expect(all).not.toContain(TEST_LOGIN_PASSWORD);
		expect(all).not.toContain("dono@exemplo.test");
		expect(r.backing.resolved).toEqual([]);
		expect(out.status === "ok" && out.summary).toContain("Check it with browser_map");
	});

	async function approved(r: ReturnType<typeof rig>, args: Record<string, unknown>) {
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args });
		if (pending.status !== "pending_approval") return pending;
		return r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args, grant: grantApproval(pending.request, r.f.clock.now()) });
	}

	it("sem nome: o cartão diz que é o login do site da página e a VM recebe a ação SEM nome (ela acha pelo site)", async () => {
		const r = rig();
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: { fields: ARGS.fields } });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		expect(pending.request.riskFacts.target).toContain("site da página atual");
		r.vm.respond = () => ({ ok: true, data: { login: "banco", filled: ["username", "password"], site: "banco.example", submitted: false } });
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args: { fields: ARGS.fields }, grant: grantApproval(pending.request, r.f.clock.now()) });
		expect(out.status).toBe("ok");
		expect(r.vm.actions).toEqual([{ userId: "owner-1", action: { kind: VAULT_KINDS.loginFill, params: { fields: ARGS.fields, submit: false } } }]);
		expect(out.status === "ok" && out.summary).toContain('of "banco" on banco.example');
		expect(JSON.stringify({ out, actions: r.vm.actions })).not.toContain(TEST_LOGIN_PASSWORD);
	});

	it("sem nome: a VM recusa (0 ou 2+ candidatos) e o erro dela chega ao modelo com a lista; nada de sucesso falso", async () => {
		const r = rig();
		r.vm.respond = () => ({ ok: false, error: 'More than one saved login belongs to banco.example: "banco" (banco.example), "banco-conjunta" (banco.example). Nothing was typed.' });
		const out = await approved(r, { fields: ARGS.fields });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("banco-conjunta");
	});

	it("sem nome e sem nenhum login com site salvo: erro honesto sem chamar a VM; só os logins do dono contam", async () => {
		const r = rig([{ owner: "owner-1", id: "sem-site", kind: "login", password: TEST_LOGIN_PASSWORD, username: "x" }, { owner: "owner-2", id: "banco-b", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco.example" }]);
		const out = await approved(r, { fields: ARGS.fields });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("no site login with a saved site");
		expect(r.vm.actions).toHaveLength(0);
	});

	it("com nome continua igual: leva o nome (e o nome errado lembra que dá para omitir)", async () => {
		const r = rig();
		const out = await approved(r, { login: "nao-existe", fields: ARGS.fields });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("omit login");
	});

	it("login que não existe (ou é de outro dono) diz os nomes do dono, não os dos outros", async () => {
		const r = rig();
		const out = await approved(r, { login: "chave-do-b", fields: ARGS.fields });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("banco");
		expect(JSON.stringify(out)).not.toContain("chave-do-b\"");
		expect(r.vm.actions).toHaveLength(0);
	});

	it("um segredo simples não é login", async () => {
		const r = rig();
		expect((await approved(r, { login: "stripe-key", fields: ARGS.fields })).status).toBe("error");
		expect(r.vm.actions).toHaveLength(0);
	});

	it("login sem site salvo não é digitado em lugar nenhum", async () => {
		const r = rig();
		const out = await approved(r, { login: "sem-site", fields: ARGS.fields });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("no saved site");
		expect(r.vm.actions).toHaveLength(0);
	});

	it("código 2FA e campo desconhecido são recusados com o aceito (depois do cartão, como toda tool)", async () => {
		const r = rig();
		for (const args of [{ login: "banco", fields: ["totp"] }, { login: "banco", password: "x", fields: ARGS.fields }, { login: "banco", fields: [] }, { login: "banco", fields: [{ key: "password", ref: "#senha" }] }, { login: "banco", fields: [{ key: "password", ref: "f1e3" }] }, { login: "banco", fields: ARGS.fields, usernameSelector: "#u" }]) {
			const out = await approved(r, args);
			expect(out.status).toBe("error");
			expect(JSON.stringify(out)).toBeTruthy();
		}
		expect(r.vm.actions).toHaveLength(0);
	});

	it("a VM recusa (página de outro site): ok:false com o motivo real, nada de sucesso falso", async () => {
		const r = rig();
		r.vm.respond = () => ({ ok: false, error: "Refused: the current page (evil.example) is not the saved site of this login (banco.example). Nothing was typed." });
		const out = await approved(r, ARGS);
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("evil.example");
	});

	it("VM fora do ar ou resposta em formato estranho também são erro", async () => {
		const r = rig();
		r.vm.respond = () => {
			throw new Error("connection reset");
		};
		expect((await approved(r, ARGS)).status).toBe("error");
		const r2 = rig();
		r2.vm.respond = () => ({ ok: true, data: { done: true } });
		const out2 = await approved(r2, ARGS);
		expect(out2.status).toBe("error");
	});

	it("o resultado da VM com um valor que escapou é redigido", async () => {
		const r = rig();
		await r.ports.vault.resolve("owner-1", "stripe-key");
		r.vm.respond = () => ({ ok: false, error: `field rejected ${TEST_SECRET_VALUE}` });
		const out = await approved(r, ARGS);
		expect(JSON.stringify(out)).not.toContain(TEST_SECRET_VALUE);
	});
});

describe("marcador {{secret:NOME}} no executor", () => {
	/** Usar o cofre é `credential`: cartão sempre. Esta ajuda pede, aprova e roda a chamada. */
	async function runApproved(r: ReturnType<typeof rig>, tool: ReturnType<typeof defineTool>, args: Record<string, unknown>) {
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool, args });
		if (pending.status !== "pending_approval") return pending;
		return r.executor.executeCall({ callId: "c1", step: 1, tool, args, grant: grantApproval(pending.request, r.f.clock.now()) });
	}

	function echoTool(opts: { accepts: boolean; effect?: "read" | "write_external"; seen?: unknown[] }) {
		return defineTool({
			name: "call_service",
			description: "Test tool that sends args to the owner's service and echoes the answer.",
			inputSchema: z.object({ header: z.string(), body: z.string().optional(), nested: z.object({ k: z.string() }).optional() }),
			effect: opts.effect ?? "read",
			...(opts.effect === "write_external" && { riskFacts: () => ({ target: "servico" }) }),
			acceptsSecretRefs: opts.accepts,
			execute: (args) => {
				opts.seen?.push(structuredClone(args));
				// Serviço que devolve o que recebeu (o pior caso para vazar).
				return { ok: true, summary: `service answered: ${args.header}`, ...(opts.effect === "write_external" && { receipt: { what: "chamou o serviço", where: "servico" } }) };
			},
		});
	}

	it("a tool recebe o valor, e a saída do executor sai redigida", async () => {
		const r = rig();
		const seen: unknown[] = [];
		const out = await runApproved(r, echoTool({ accepts: true, seen }), { header: "Bearer {{secret:stripe-key}}", nested: { k: "{{secret:stripe-key}}" } });
		expect(seen).toEqual([{ header: `Bearer ${TEST_SECRET_VALUE}`, nested: { k: TEST_SECRET_VALUE } }]);
		expect(out.status).toBe("ok");
		expect(JSON.stringify(out)).not.toContain(TEST_SECRET_VALUE);
		expect(out.status === "ok" && out.summary).toContain("[redacted]");
		expect(r.backing.resolved.every((x) => x.userId === "owner-1")).toBe(true);
	});

	it("valor em texto JSON vai escapado (aspas e barras não quebram o corpo)", async () => {
		const r = rig([{ owner: "owner-1", id: "k", kind: "secret", value: 'a"b\\c' }]);
		const seen: Array<{ header: string; body: string }> = [];
		await runApproved(r, echoTool({ accepts: true, seen }), { header: "x", body: '{"token":"{{secret:k}}"}' });
		expect(JSON.parse(seen[0]!.body)).toEqual({ token: 'a"b\\c' });
	});

	it("com aprovação: o cartão, o journal e o hash ficam com o marcador (nunca o valor)", async () => {
		const r = rig();
		const seen: unknown[] = [];
		const tool = echoTool({ accepts: true, effect: "write_external", seen });
		const args = { header: "Bearer {{secret:stripe-key}}" };
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool, args });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		expect(r.backing.resolved).toEqual([]); // nada foi lido antes da aprovação
		expect(JSON.stringify(pending.request)).not.toContain(TEST_SECRET_VALUE);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool, args, grant: grantApproval(pending.request, r.f.clock.now()) });
		expect(out.status).toBe("ok");
		expect(seen).toEqual([{ header: `Bearer ${TEST_SECRET_VALUE}` }]);
		expect(JSON.stringify({ out, journal: r.f.journal, receipts: r.f.receipts, request: pending.request })).not.toContain(TEST_SECRET_VALUE);
	});

	it("nome que não existe: erro antes de rodar, com a dica do secret_request", async () => {
		const r = rig();
		const seen: unknown[] = [];
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: echoTool({ accepts: true, seen }), args: { header: "{{secret:nao-existe}}" } });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("secret_request");
		expect(seen).toHaveLength(0);
	});

	it("segredo de OUTRO dono com o mesmo nome nunca é lido", async () => {
		const r = rig(ITEMS, { ownerId: "owner-2" });
		const seen: Array<{ header: string }> = [];
		await runApproved(r, echoTool({ accepts: true, seen }), { header: "{{secret:stripe-key}}" });
		expect(seen[0]!.header).toBe("outra-chave-do-b-456");
		expect(r.backing.resolved).toEqual([{ userId: "owner-2", handleId: "stripe-key" }]);
		const own = rig(ITEMS, { ownerId: "owner-2" });
		const miss = await own.executor.executeCall({ callId: "c1", step: 1, tool: echoTool({ accepts: true }), args: { header: "{{secret:banco}}" } });
		expect(miss.status).toBe("error"); // "banco" é do dono 1
	});

	it("senha de login e segredo de rotina não vão em argumento: a dica manda usar login_fill", async () => {
		const r = rig();
		for (const header of ["{{login:banco.password}}", "{{secret:rotina:minha}}", "{{secret:banco}}"]) {
			const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: echoTool({ accepts: true }), args: { header } });
			expect(out.status).toBe("error");
		}
		expect(r.backing.resolved).toEqual([]);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: echoTool({ accepts: true }), args: { header: "{{login:banco.password}}" } });
		expect(JSON.stringify(out)).toContain("login_fill");
	});

	it("tool que não aceita marcador recebe o texto literal e o cofre não é tocado", async () => {
		const r = rig();
		const seen: Array<{ header: string }> = [];
		await r.executor.executeCall({ callId: "c1", step: 1, tool: echoTool({ accepts: false, seen }), args: { header: "{{secret:stripe-key}}" } });
		expect(seen[0]!.header).toBe("{{secret:stripe-key}}");
		expect(r.backing.resolved).toEqual([]);
	});
});

describe("o valor nunca chega ao modelo (motor completo)", () => {
	it("secret_list + chamada com marcador: pedidos ao modelo, eventos, journal, recibos e checkpoint sem o valor", async () => {
		const backing = new FakeVault(ITEMS);
		const sent: unknown[] = [];
		const service = defineTool({
			name: "call_service",
			description: "Test tool for the owner's service.",
			inputSchema: z.object({ header: z.string() }),
			effect: "write_external",
			riskFacts: () => ({ target: "servico" }),
			acceptsSecretRefs: true,
			execute: (args) => {
				sent.push(args.header);
				// O serviço devolve o que recebeu: o valor tenta voltar ao modelo.
				return { ok: true, summary: `service said: ${args.header}`, receipt: { what: `chamou o serviço com ${args.header}`, where: "servico" } };
			},
		});
		const vault = createVaultCapability({ vault: backing, requests: new FakeSecretRequests() });
		const h = kernelHarness(
			[reply({ calls: [call("c1", "secret_list", {})] }), reply({ calls: [call("c2", "call_service", { header: "Bearer {{secret:stripe-key}}" })] }), reply({ text: "Pronto." })],
			{ tools: [...vault.tools, service] },
		);
		(h.ports as { vault: unknown }).vault = backing;
		const result = await h.run({ policy: { ...chatPolicy, autonomy: "autonomous" } });
		// Mesmo em autonomia total, usar o cofre pede o cartão: o run estaciona e nada foi enviado nem lido.
		expect(result.status).toBe("parked");
		expect(sent).toEqual([]);
		expect(backing.resolved).toEqual([]);
		const everything = JSON.stringify({ events: h.log.events, requests: h.llm.requests, journal: h.journal, receipts: h.receipts, checkpoints: [...h.runs.checkpoints.values()] });
		expect(everything).not.toContain(TEST_SECRET_VALUE);
		expect(everything).not.toContain(TEST_LOGIN_PASSWORD);
		expect(everything).toContain("{{secret:stripe-key}}");
	});
});

describe("adaptador da porta: metadado, nunca valor", () => {
	it("copia só os campos de metadado do backend", async () => {
		const vault = createVaultAdapter({
			listHandles: async () => [{ id: "banco", label: "Banco", kind: "login", site: "banco.example", username: "u", fields: [{ key: "senha", label: "Senha", secret: true, value: TEST_LOGIN_PASSWORD }], password: TEST_LOGIN_PASSWORD, value: TEST_SECRET_VALUE } as never],
			resolveSecret: async () => null,
		});
		const handles = await vault.listHandles("owner-1");
		expect(handles).toEqual([{ id: "banco", label: "Banco", kind: "login", site: "banco.example", username: "u", fields: [{ key: "senha", label: "Senha", secret: true }] }]);
		expect(JSON.stringify(handles)).not.toContain(TEST_LOGIN_PASSWORD);
		expect(JSON.stringify(handles)).not.toContain(TEST_SECRET_VALUE);
	});
});

describe("login com campos decididos pela IA (F9)", () => {
	const CPF = "123.456.789-09";
	const NEW_ITEMS: FakeVaultItem[] = [
		...ITEMS,
		{ owner: "owner-1", id: "plataforma", label: "Plataforma", kind: "login", password: "", site: "https://www.plataforma.example/entrar", fields: [{ key: "nome", label: "Nome", secret: false, value: "Ana Souza" }, { key: "cpf", label: "CPF", secret: true, value: CPF }] },
	];
	const FIELDS = [
		{ key: "nome", label: "Nome", secret: false },
		{ key: "cpf", label: "CPF", secret: true },
		{ key: "senha", label: "Senha", secret: true },
	];

	async function approvedFill(r: ReturnType<typeof rig>, args: Record<string, unknown>) {
		const pending = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		return r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("login_fill"), args, grant: grantApproval(pending.request, r.f.clock.now()) });
	}

	it("secret_list mostra chave, rótulo e se é secreto, nunca o valor; login antigo aparece como username e password", async () => {
		const r = rig(NEW_ITEMS);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_list"), args: {} });
		const text = JSON.stringify(out);
		expect(text).toContain("cpf (CPF, secret)");
		expect(text).toContain("nome (Nome)");
		expect(text).toContain("password (Senha, secret)");
		expect(text).not.toContain(CPF);
		expect(text).not.toContain("Ana Souza");
		expect(text).not.toContain(TEST_LOGIN_PASSWORD);
	});

	it("secret_request kind login: um cartão com todos os campos da página, no site normalizado; encerra o turno", async () => {
		const r = rig();
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { kind: "login", site: "https://WWW.Novo.example/entrar?x=1", fields: FIELDS, reason: "Entrar na plataforma." } });
		expect(out.status).toBe("ok");
		expect(r.requests.asks).toEqual([{ userId: "owner-1", runId: "run-1", request: { names: ["nome", "cpf", "senha"], reason: "Entrar na plataforma.", login: { site: "novo.example", fields: FIELDS } } }]);
	});

	it("segunda etapa do mesmo site pede só o que falta e leva o nome do item existente (os campos se juntam, nunca um item novo)", async () => {
		const r = rig(NEW_ITEMS);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { kind: "login", site: "plataforma.example", fields: [{ key: "cpf", label: "CPF", secret: true }, { key: "senha", label: "Senha", secret: true }], reason: "Segunda etapa." } });
		expect(out.status).toBe("ok");
		expect(r.requests.asks).toHaveLength(1);
		expect(r.requests.asks[0]!.request.login).toEqual({ site: "plataforma.example", name: "plataforma", fields: [{ key: "senha", label: "Senha", secret: true }] });
		expect(r.requests.asks[0]!.request.names).toEqual(["senha"]);
		expect(out.status === "ok" && out.summary).toContain("already has: nome, cpf");
	});

	it("tudo já salvo: nenhum cartão", async () => {
		const r = rig(NEW_ITEMS);
		const out = await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { kind: "login", site: "plataforma.example", fields: [{ key: "nome", label: "Nome", secret: false }], reason: "x" } });
		expect(out.status === "ok" && out.summary).toContain("nothing was asked");
		expect(r.requests.asks).toHaveLength(0);
	});

	it("o login de OUTRO dono no mesmo site não conta: o cartão pede tudo", async () => {
		const r = rig([...NEW_ITEMS, { owner: "owner-2", id: "novo", kind: "login", password: "", site: "novo.example", fields: [{ key: "email", label: "E-mail", secret: false, value: "b@x.test" }] }]);
		await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args: { kind: "login", site: "novo.example", fields: [{ key: "email", label: "E-mail", secret: false }], reason: "x" } });
		expect(r.requests.asks[0]!.request.names).toEqual(["email"]);
		expect(r.requests.asks[0]!.request.login?.name).toBeUndefined();
	});

	it("pedido de login inválido falha com o aceito, sem cartão", async () => {
		const r = rig();
		const bad: Array<Record<string, unknown>> = [
			{ kind: "login", fields: FIELDS, reason: "x" },
			{ kind: "login", site: "not a site", fields: FIELDS, reason: "x" },
			{ kind: "login", site: "a.example", reason: "x" },
			{ kind: "login", site: "a.example", fields: [{ key: "com espaço", label: "X", secret: false }], reason: "x" },
			{ kind: "login", site: "a.example", fields: [{ key: "a", label: "A", secret: false }, { key: "a", label: "B", secret: true }], reason: "x" },
			{ kind: "login", site: "a.example", names: ["a"], fields: FIELDS, reason: "x" },
			{ kind: "login", site: "a.example", name: "stripe-key", fields: FIELDS, reason: "x" },
			{ site: "a.example", names: ["a"], reason: "x" },
		];
		for (const args of bad) expect((await r.executor.executeCall({ callId: "c1", step: 1, tool: r.tool("secret_request"), args })).status).toBe("error");
		expect(r.requests.asks).toHaveLength(0);
	});

	it("login_fill com mapeamento: a VM recebe chave -> ref (nunca valor) e o resultado só tem chaves", async () => {
		const r = rig(NEW_ITEMS);
		const args = { login: "plataforma", fields: [{ key: "nome", ref: "e4" }, { key: "cpf", ref: "a7" }], submit: false };
		r.vm.respond = () => ({ ok: true, data: { login: "plataforma", filled: ["nome", "cpf"], site: "plataforma.example", submitted: false } });
		const out = await approvedFill(r, args);
		expect(out.status).toBe("ok");
		expect(r.vm.actions[0]!.action.params).toEqual({ login: "plataforma", fields: args.fields, submit: false });
		const all = JSON.stringify({ out, actions: r.vm.actions, receipts: r.f.receipts, journal: r.f.journal });
		expect(all).not.toContain(CPF);
		expect(all).not.toContain("Ana Souza");
		expect(out.status === "ok" && out.summary).toContain("nome, cpf");
	});

	it("campo salvo que não existe: erro honesto com as chaves salvas (só nomes), sem chamar a VM", async () => {
		const r = rig(NEW_ITEMS);
		const out = await approvedFill(r, { login: "plataforma", fields: [{ key: "email", ref: "e1" }] });
		expect(out.status).toBe("error");
		const text = JSON.stringify(out);
		expect(text).toContain('no saved field called \\"email\\"');
		expect(text).toContain("nome, cpf");
		expect(text).not.toContain(CPF);
		expect(r.vm.actions).toHaveLength(0);
	});

	it("o mesmo campo salvo (ou o mesmo ref) duas vezes é recusado", async () => {
		const r = rig(NEW_ITEMS);
		for (const fields of [[{ key: "nome", ref: "e1" }, { key: "nome", ref: "e2" }], [{ key: "nome", ref: "e1" }, { key: "cpf", ref: "e1" }]]) {
			expect((await approvedFill(r, { login: "plataforma", fields })).status).toBe("error");
		}
		expect(r.vm.actions).toHaveLength(0);
	});

	it("sem dono: secret_request e login_fill ficam fora (só secret_list)", () => {
		const r = rig(NEW_ITEMS, { readOnly: true });
		expect(r.capability.tools.map((t) => t.name)).toEqual(["secret_list"]);
	});
});
