// F9 parte 2: o `login_fill` do run de ROTINA (decisão do dono, 09/11): só existe com a permissão que o dono aprovou na criação da rotina,
// só para aquele login e aquele site; sem dono não há cartão por uso e o valor nunca passa pelo modelo.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createExecutor, type ExecutorDeps } from "../../contract/index.js";
import { defineTool } from "../../tools/define-tool.js";
import type { Ports } from "../../ports/index.js";
import type { Sandbox, SandboxAction, SandboxResult } from "../../ports/sandbox.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import { FakeVault, TEST_LOGIN_PASSWORD, type FakeVaultItem } from "../../testing/vault-fakes.js";
import { createVaultCapability, VAULT_KINDS } from "./index.js";

const ITEMS: FakeVaultItem[] = [
	{ owner: "owner-1", id: "banco", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco.example", username: "dono@exemplo.test" },
	{ owner: "owner-1", id: "sem-site", kind: "login", password: TEST_LOGIN_PASSWORD, username: "x" },
	{ owner: "owner-2", id: "banco-do-b", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco-b.example", username: "b" },
];
const routinePolicy: ExecutorDeps["policy"] = { surface: "routine", ownerPresent: false, autonomy: "balanced", rules: [] };
const text = (out: { status: string }) => JSON.stringify(out);

class FakeVm implements Sandbox {
	readonly actions: Array<{ userId: string; action: SandboxAction }> = [];
	respond: (action: SandboxAction) => SandboxResult = () => ({ ok: true, data: { login: "banco", filled: ["username", "password"], site: "banco.example", submitted: false } });
	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.actions.push({ userId, action });
		return this.respond(action);
	}
	async release() {}
}

describe("login_fill no run de rotina (só o login e o site aprovados)", () => {
	const fields = [{ key: "username", ref: "e1" }, { key: "password", ref: "e2" }];
	function loginRig(opts: { grant?: { login: string; site: string }; ownerId?: string }) {
		const vm = new FakeVm();
		const f = fakePorts();
		const vault = new FakeVault(ITEMS);
		const capability = createVaultCapability({ vault, readOnly: true, ...(opts.grant && { routineLogin: opts.grant }) });
		const ports = { ...f.ports, vault, sandbox: vm } as unknown as Ports;
		const executor = createExecutor({ runId: "run-1", ownerId: opts.ownerId ?? "owner-1", ports, hash: sha256, policy: routinePolicy });
		const run = (args: unknown) => executor.executeCall({ callId: "c1", step: 1, tool: capability.tools.find((t) => t.name === "login_fill")!, args });
		return { capability, vm, run };
	}

	it("sem permissão a rotina não tem login_fill (e a instrução manda dizer que não entrou); com permissão tem só o fixo", () => {
		const without = loginRig({});
		expect(without.capability.tools.map((t) => t.name)).toEqual(["secret_list"]);
		expect(without.capability.instructions).toContain("no permission to sign in");
		const granted = loginRig({ grant: { login: "banco", site: "banco.example" } });
		expect(granted.capability.tools.map((t) => t.name)).toEqual(["secret_list", "login_fill"]);
		expect(granted.capability.instructions).toContain("banco.example");
	});

	// C7 da auditoria F9: usar {{secret:nome}} é ação de credencial e fica OCULTA sem dono; a instrução da rotina não pode mandar usar.
	it("a rotina não pode usar {{secret:nome}} (fica fora sem dono) e as instruções dizem isso em vez de ensinar a usar", async () => {
		const withSecret = defineTool({ name: "call_connector", description: "x", inputSchema: z.object({ q: z.string() }), effect: "read", acceptsSecretRefs: true, execute: () => ({ ok: true, summary: "ok" }) });
		const f = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: { ...f.ports, vault: new FakeVault(ITEMS) } as unknown as Ports, hash: sha256, policy: routinePolicy });
		const out = await executor.executeCall({ callId: "c1", step: 1, tool: withSecret, args: { q: "{{secret:chave}}" } });
		expect(out.status).toBe("not_available");
		for (const caps of [loginRig({}).capability, loginRig({ grant: { login: "banco", site: "banco.example" } }).capability]) {
			expect(caps.instructions).not.toMatch(/goes into a connector call as \{\{secret/);
			expect(caps.instructions).toContain("cannot use a plain secret");
			expect(caps.instructions).toMatch(/did not run|not happen|did not/);
		}
	});

	it("roda SEM cartão (a aprovação foi a da criação) e leva à VM o login fixo e o site permitido; o valor nunca passa", async () => {
		const r = loginRig({ grant: { login: "banco", site: "banco.example" } });
		const out = await r.run({ fields, submit: false });
		expect(out.status).toBe("ok");
		expect(r.vm.actions).toHaveLength(1);
		expect(r.vm.actions[0]!.action).toEqual({ kind: VAULT_KINDS.loginFill, params: { login: "banco", fields, submit: false, onlySite: "banco.example" } });
		expect(JSON.stringify(out)).not.toContain(TEST_LOGIN_PASSWORD);
	});

	it("o modelo não escolhe outro login nem outro site: campo desconhecido falha; recusa da VM (site diferente) volta como erro honesto", async () => {
		const r = loginRig({ grant: { login: "banco", site: "banco.example" } });
		const forged = await r.run({ login: "sem-site", fields });
		expect(forged.status).toBe("error");
		expect(text(forged)).toContain("Accepted fields: fields, submit");
		expect(r.vm.actions).toEqual([]);
		r.vm.respond = () => ({ ok: false, error: "Refused: the current page (outro.example) is not banco.example, the only site this routine may sign in to. Nothing was typed." });
		const refused = await r.run({ fields });
		expect(refused.status).toBe("error");
		expect(text(refused)).toContain("only site this routine may sign in to");
		expect(text(refused)).toContain("could not sign in");
	});

	it("B com a permissão de A não digita: o login não está no cofre de B e nada vai à VM", async () => {
		const r = loginRig({ grant: { login: "banco", site: "banco.example" }, ownerId: "owner-2" });
		const out = await r.run({ fields, submit: false });
		expect(out.status).toBe("error");
		expect(text(out)).toContain("not in the vault any more");
		expect(r.vm.actions).toEqual([]);
	});

	it("campo que o login não tem, chave repetida e dois campos no mesmo ref falham antes da VM", async () => {
		const r = loginRig({ grant: { login: "banco", site: "banco.example" } });
		expect(text(await r.run({ fields: [{ key: "cpf", ref: "e1" }] }))).toContain("no saved field");
		expect(text(await r.run({ fields: [{ key: "username", ref: "e1" }, { key: "username", ref: "e2" }] }))).toContain("more than once");
		expect(text(await r.run({ fields: [{ key: "username", ref: "e1" }, { key: "password", ref: "e1" }] }))).toContain("same page input");
		expect(r.vm.actions).toEqual([]);
	});
});
