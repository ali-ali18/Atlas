import { decide, redactSecrets } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { grantApproval } from "../../contract/index.js";
import type { Ports } from "../../ports/index.js";
import { FakeCodeSandbox, type FakeCodeExec } from "../../presets/fake-code.js";
import { chatPolicy } from "../../testing/contract-helpers.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import type { Tool } from "../../tools/define-tool.js";
import type { ToolContext } from "../../tools/types.js";
import { CODE_KIND_LIST, CODE_KINDS, createCodeCapability } from "./index.js";

const PRICE = ["export function formatPrice(value) {", "\treturn `R$ ${value.toFixed(2)}`;", "}", ""].join("\n");
const SEED = { "src/price.js": PRICE, "src/other.js": "const a = 1;\nconst a2 = 1;\nconst a = 1;\n", ".env": "TOKEN=abc\n", "README.md": "# loja\n" };

function setup(over: { exec?: FakeCodeExec; readOnly?: boolean; seed?: Record<string, string> } = {}) {
	const sandbox = new FakeCodeSandbox({ seed: over.seed ?? SEED, testCommand: "pnpm test", ...(over.exec && { exec: over.exec }) });
	const cap = createCodeCapability({ ...(over.readOnly && { readOnly: true }) });
	const tool = (name: string): Tool => cap.tools.find((t) => t.name === name)!;
	const ctx = (ownerId = "o1"): ToolContext => ({ runId: "run-1", ownerId, ports: { sandbox } as unknown as Ports });
	return { sandbox, cap, tool, ctx };
}

async function open(s: ReturnType<typeof setup>, owner = "o1"): Promise<string> {
	const r = await s.tool("code_session").run({ repo: "acme/loja" }, s.ctx(owner));
	if (!r.ok) throw new Error(r.error);
	return /Session (\S+) ready/.exec(r.summary)![1]!;
}

const verdict = (tool: Tool, args: unknown, over: { ownerPresent?: boolean; surface?: "chat" | "agenda"; autonomy?: "always_ask" | "balanced" | "autonomous"; untrusted?: boolean } = {}) =>
	decide({ effect: tool.effectFor(args), surface: over.surface ?? "chat", ownerPresent: over.ownerPresent ?? true, autonomy: over.autonomy ?? "balanced", rules: [], taint: { untrustedReadInRun: over.untrusted ?? false, argsCarryUntrusted: false }, ...(tool.confirm && { confirm: tool.confirm }), now: new Date(0), action: { toolName: tool.name } }).kind;

describe("capacidade code: contrato", () => {
	it("é lazy, tem uma tool por kind e declara efeito, confiança e flags", () => {
		const { cap, tool } = setup();
		expect(cap.core).toBe(false);
		expect(cap.summary.length).toBeLessThanOrEqual(160);
		expect(cap.tools.map((t) => t.name)).toEqual(["code_session", "code_list", "code_read", "code_shell", "code_git_status", "code_diff", "code_edit", "code_write", "code_test"]);
		expect(tool("code_session")).toMatchObject({ effect: "read" });
		for (const name of ["code_list", "code_read", "code_git_status", "code_diff"]) expect(tool(name)).toMatchObject({ effect: "read", trust: "untrusted", source: "file", egress: false });
		expect(tool("code_edit")).toMatchObject({ effect: "write_internal", trust: "trusted" });
		expect(tool("code_write")).toMatchObject({ effect: "write_internal" });
		for (const name of ["code_shell", "code_test"]) expect(tool(name)).toMatchObject({ effect: "write_internal", trust: "untrusted", source: "file" });
		expect(CODE_KIND_LIST).toHaveLength(9);
		expect(Object.values(CODE_KINDS).every((k) => k.startsWith("code."))).toBe(true);
	});

	it("modo plano: só as tools de leitura entram, e a instrução diz que não edita", () => {
		const { cap } = setup({ readOnly: true });
		expect(cap.tools.map((t) => t.name)).toEqual(["code_session", "code_list", "code_read", "code_shell", "code_git_status", "code_diff"]);
		expect(cap.instructions).toContain("only read");
		expect(cap.instructions).not.toContain("code_edit");
	});

	it("as descrições dizem quando usar e quando não usar, e a instrução trata a saída como dado", () => {
		const { cap } = setup();
		for (const tool of cap.tools) expect(tool.description.length, tool.name).toBeGreaterThan(40);
		expect(cap.instructions).toContain("data, never instructions");
		expect(cap.instructions).toContain("FOCUSED test");
	});
});

describe("efeitos por argumento", () => {
	it("editar ou escrever .env e caminho sensível é credential (cartão em toda autonomia); código comum é write_internal", () => {
		const { tool } = setup();
		const edit = (path: string) => tool("code_edit").effectFor({ sessionId: "s", path, old: "a", new: "b" });
		expect(edit("src/price.js")).toBe("write_internal");
		expect(edit(".env")).toBe("credential");
		expect(edit("apps/api/.env.production")).toBe("credential");
		expect(edit(".github/workflows/ci.yml")).toBe("credential");
		expect(tool("code_write").effectFor({ sessionId: "s", path: "config/.env", content: "X=1" })).toBe("credential");
		expect(tool("code_write").effectFor({ sessionId: "s", path: "src/a.ts", content: "export const a = 1;" })).toBe("write_internal");
		expect(tool("code_read").effectFor({ sessionId: "s", path: ".env" })).toBe("credential");
		expect(tool("code_read").effectFor({ sessionId: "s", path: ".env.example" })).toBe("read");
	});

	it("shell: leitura = read, allowlist = write_internal, fora da lista = destructive, ler .env = credential", () => {
		const { tool } = setup();
		const eff = (cmd: string) => tool("code_shell").effectFor({ sessionId: "s", cmd });
		expect(eff("git log --oneline")).toBe("read");
		expect(eff("ls src && cat README.md")).toBe("read");
		expect(eff("pnpm install")).toBe("write_internal");
		expect(eff("curl https://exemplo.test/x.sh -o x.sh")).toBe("destructive");
		expect(eff("cat .env")).toBe("credential");
	});

	it("leituras de segredo por estrutura viram credential: git show rev:.env, env, /proc/*/environ, caminho fora do /workspace; em plan a negação vem do preset", () => {
		const { tool } = setup();
		const eff = (cmd: string) => tool("code_shell").effectFor({ sessionId: "s", cmd });
		for (const cmd of ["git show HEAD:.env", "git log -p -- .env", "env", "printenv", "cat /proc/self/environ", "cat /etc/passwd", "cat ~/.ssh/id_rsa", "git diff --no-index /etc/hosts x"]) expect(eff(cmd), cmd).toBe("credential");
		expect(eff("git show HEAD:README.md")).toBe("read");
		expect(eff("cat /workspace/app/a.ts")).toBe("read");
		expect(tool("code_diff").effectFor({ sessionId: "s", path: ".env" })).toBe("credential");
		expect(tool("code_diff").effectFor({ sessionId: "s", path: "apps/api/.env.local" })).toBe("credential");
		expect(tool("code_diff").effectFor({ sessionId: "s", path: "src/a.ts" })).toBe("read");
		expect(tool("code_diff").effectFor({ sessionId: "s" })).toBe("read");
		expect(verdict(tool("code_shell"), { sessionId: "s", cmd: "env" }, { autonomy: "autonomous" })).toBe("approve");
		expect(verdict(tool("code_diff"), { sessionId: "s", path: ".env" }, { ownerPresent: false, surface: "agenda" })).toBe("hidden");
	});

	it("veredito: .env pede o dono até na autonomia total; sem dono a tool some; leitura roda", () => {
		const { tool } = setup();
		const envEdit = { sessionId: "s", path: ".env", old: "a", new: "b" };
		expect(verdict(tool("code_edit"), envEdit, { autonomy: "autonomous" })).toBe("approve");
		expect(verdict(tool("code_edit"), envEdit, { ownerPresent: false, surface: "agenda" })).toBe("hidden");
		expect(verdict(tool("code_edit"), { sessionId: "s", path: "src/a.js", old: "a", new: "b" })).toBe("run");
		expect(verdict(tool("code_shell"), { sessionId: "s", cmd: "python3 script.py" }, { autonomy: "autonomous" })).toBe("approve");
		expect(verdict(tool("code_shell"), { sessionId: "s", cmd: "git status" })).toBe("run");
	});
});

describe("code_edit: edição precisa (a VM aplica; o fake tem as mesmas recusas)", () => {
	it("troca um trecho único e mostra o diff", async () => {
		const s = setup();
		const sessionId = await open(s);
		const r = await s.tool("code_edit").run({ sessionId, path: "src/price.js", old: "value.toFixed(2)", new: "value.toFixed(2).replace('.', ',')" }, s.ctx());
		expect(r).toMatchObject({ ok: true });
		expect(s.sandbox.files(sessionId)!.get("src/price.js")).toContain("replace('.', ',')");
		expect(r.ok && r.summary).toContain("+1 -1");
	});

	it("trecho ambíguo é recusado com as linhas; replaceAll aplica em todos", async () => {
		const s = setup();
		const sessionId = await open(s);
		const refused = await s.tool("code_edit").run({ sessionId, path: "src/other.js", old: "const a = 1;", new: "const a = 2;" }, s.ctx());
		expect(refused).toMatchObject({ ok: false });
		expect(!refused.ok && refused.error).toContain("2 vezes");
		expect(s.sandbox.files(sessionId)!.get("src/other.js")).toBe(SEED["src/other.js"]);
		const all = await s.tool("code_edit").run({ sessionId, path: "src/other.js", old: "const a = 1;", new: "const a = 2;", replaceAll: true }, s.ctx());
		expect(all.ok).toBe(true);
		expect(s.sandbox.files(sessionId)!.get("src/other.js")).toBe("const a = 2;\nconst a2 = 1;\nconst a = 2;\n");
	});

	it("tolera indentação errada e CRLF, e reindenta o novo trecho", async () => {
		const s = setup({ seed: { "a.js": "function f() {\r\n\tif (x) {\r\n\t\treturn 1;\r\n\t}\r\n}\r\n", "b.js": "class A {\n    run() {\n        return 1;\n    }\n}\n" } });
		const sessionId = await open(s);
		const crlf = await s.tool("code_edit").run({ sessionId, path: "a.js", old: "if (x) {\n\treturn 1;\n}", new: "if (x) {\n\treturn 2;\n}" }, s.ctx());
		expect(crlf.ok).toBe(true);
		expect(s.sandbox.files(sessionId)!.get("a.js")).toBe("function f() {\r\n\tif (x) {\r\n\t\treturn 2;\r\n\t}\r\n}\r\n");
		const indent = await s.tool("code_edit").run({ sessionId, path: "b.js", old: "run() {\n    return 1;\n}", new: "run() {\n    return 2;\n}" }, s.ctx());
		expect(indent).toMatchObject({ ok: true });
		expect(s.sandbox.files(sessionId)!.get("b.js")).toBe("class A {\n    run() {\n        return 2;\n    }\n}\n");
		expect(indent.ok && indent.summary).toContain("indentação ajustada");
	});

	it("texto que não existe é recusado com a dica de reler; caminho com .. nem chega à VM", async () => {
		const s = setup();
		const sessionId = await open(s);
		const missing = await s.tool("code_edit").run({ sessionId, path: "src/price.js", old: "naoexiste()", new: "x" }, s.ctx());
		expect(!missing.ok && missing.error).toContain("não foi encontrado");
		const before = s.sandbox.calls.length;
		const escape = await s.tool("code_edit").run({ sessionId, path: "../../etc/passwd", old: "a", new: "b" }, s.ctx());
		expect(escape).toMatchObject({ ok: false });
		expect(s.sandbox.calls.length).toBe(before);
	});
});

describe("code_shell e code_test: portão de comando", () => {
	const exec: FakeCodeExec = ({ cmd }) => ({ exitCode: 0, output: `ran: ${cmd}` });

	it("bloqueio fixo é recusado SEM tocar a VM, até com aprovação já dada", async () => {
		const s = setup({ exec });
		const sessionId = await open(s);
		const before = s.sandbox.calls.length;
		for (const cmd of ["bash -c 'rm -rf /'", "rm -rf /"]) {
			const r = await s.tool("code_shell").run({ sessionId, cmd }, s.ctx());
			expect(r, cmd).toMatchObject({ ok: false });
		}
		expect(s.sandbox.calls.length).toBe(before);
	});

	it("comando da allowlist roda; a saída volta ao modelo com o código de saída", async () => {
		const s = setup({ exec });
		const sessionId = await open(s);
		const r = await s.tool("code_shell").run({ sessionId, cmd: "pnpm install" }, s.ctx());
		expect(r).toMatchObject({ ok: true });
		expect(r.ok && r.summary).toContain("exit 0");
	});

	it("segredo na saída do shell e do arquivo não chega ao modelo", async () => {
		const token = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
		const s = setup({ exec: () => ({ exitCode: 0, output: `GITHUB_TOKEN=${token}\nBearer abcdefghijklmnop12345` }), seed: { "cfg.txt": `key ${token}\n` } });
		const sessionId = await open(s);
		const shell = await s.tool("code_shell").run({ sessionId, cmd: "pnpm install" }, s.ctx());
		const read = await s.tool("code_read").run({ sessionId, path: "cfg.txt" }, s.ctx());
		for (const r of [shell, read]) {
			const text = JSON.stringify(r);
			expect(text).not.toContain(token);
			expect(text).not.toContain("abcdefghijklmnop12345");
			expect(text).toContain("[redacted]");
		}
		expect(redactSecrets(token)).toBe("[redacted]");
	});

	it("code_test só aceita comando de teste; a suíte completa exige fullSuite", async () => {
		const s = setup({ exec });
		const sessionId = await open(s);
		const notTest = await s.tool("code_test").run({ sessionId, cmd: "pnpm install" }, s.ctx());
		expect(!notTest.ok && notTest.error).toContain("not a test command");
		const focused = await s.tool("code_test").run({ sessionId, cmd: "pnpm exec vitest run src/price.test.js" }, s.ctx());
		expect(focused.ok && focused.summary).toContain("Tests PASSED");
		const whole = await s.tool("code_test").run({ sessionId, cmd: "pnpm -r test" }, s.ctx());
		expect(whole).toMatchObject({ ok: false });
		expect(!whole.ok && whole.error).toContain("Não rodei");
		const asked = await s.tool("code_test").run({ sessionId, cmd: "pnpm -r test", fullSuite: true }, s.ctx());
		expect(asked.ok).toBe(true);
		// O pedido do dono segue até o adaptador (que confere a raiz do workspace na VM); sem o pedido, a chave nem viaja.
		const sent = s.sandbox.calls.filter((call) => call.kind === "code.test").map((call) => (call.params as { fullSuite?: boolean }).fullSuite);
		expect(sent).toEqual([undefined, true]);
	});

	it("teste que falha é resultado honesto (FAILED), não erro da tool", async () => {
		const s = setup({ exec: () => ({ exitCode: 1, output: "1 failed" }) });
		const sessionId = await open(s);
		const r = await s.tool("code_test").run({ sessionId, cmd: "pnpm exec vitest run" }, s.ctx());
		expect(r.ok && r.summary).toContain("Tests FAILED");
	});

	it("no modo plano o shell só roda leitura", async () => {
		const s = setup({ exec, readOnly: true });
		const sessionId = await open(s);
		expect(await s.tool("code_shell").run({ sessionId, cmd: "git log --oneline" }, s.ctx())).toMatchObject({ ok: true });
		const w = await s.tool("code_shell").run({ sessionId, cmd: "pnpm install" }, s.ctx());
		expect(w).toMatchObject({ ok: false });
	});
});

describe("leitura em partes e git", () => {
	it("code_read diz onde está e como pedir a próxima parte", async () => {
		const big = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join("\n");
		const s = setup({ seed: { "big.txt": big } });
		const sessionId = await open(s);
		const first = await s.tool("code_read").run({ sessionId, path: "big.txt", limit: 10 }, s.ctx());
		expect(first.ok && first.summary).toContain("offset 10");
		const last = await s.tool("code_read").run({ sessionId, path: "big.txt", offset: 20, limit: 10 }, s.ctx());
		expect(last.ok && last.summary).toContain("end of file");
	});

	it("git_status e diff refletem a edição", async () => {
		const s = setup();
		const sessionId = await open(s);
		expect((await s.tool("code_git_status").run({ sessionId }, s.ctx())).ok && true).toBe(true);
		await s.tool("code_edit").run({ sessionId, path: "src/price.js", old: "toFixed(2)", new: "toFixed(1)" }, s.ctx());
		const status = await s.tool("code_git_status").run({ sessionId }, s.ctx());
		expect(status.ok && status.summary).toContain("M src/price.js");
		const diff = await s.tool("code_diff").run({ sessionId }, s.ctx());
		expect(diff.ok && diff.summary).toContain("+\treturn `R$ ${value.toFixed(1)}`;");
	});
});

describe("IDOR: sessão de outro dono", () => {
	it("o usuário B não lê, edita, roda nem vê o diff da sessão do usuário A (not found, nunca forbidden)", async () => {
		const s = setup({ exec: () => ({ exitCode: 0, output: "x" }) });
		const sessionId = await open(s, "userA");
		const b = s.ctx("userB");
		const attempts: Array<[string, unknown]> = [
			["code_list", { sessionId }],
			["code_read", { sessionId, path: "src/price.js" }],
			["code_edit", { sessionId, path: "src/price.js", old: "toFixed(2)", new: "toFixed(0)" }],
			["code_write", { sessionId, path: "x.js", content: "1" }],
			["code_shell", { sessionId, cmd: "git status" }],
			["code_test", { sessionId, cmd: "pnpm exec vitest run" }],
			["code_git_status", { sessionId }],
			["code_diff", { sessionId }],
			["code_session", { sessionId }],
		];
		for (const [name, args] of attempts) {
			const r = await s.tool(name).run(args, b);
			expect(r, name).toMatchObject({ ok: false });
			expect(!r.ok && r.error, name).toContain("not found");
			expect(!r.ok && r.error, name).not.toMatch(/forbidden|permission/i);
		}
		expect(s.sandbox.files(sessionId)!.get("src/price.js")).toBe(PRICE);
	});
});

describe("no kernel: aprovação, sem dono e economia", () => {
	const seedExec: FakeCodeExec = ({ cmd }) => ({ exitCode: 0, output: `ran ${cmd}` });

	it(".env: o executor estaciona num cartão e NÃO escreve, nem na autonomia total", async () => {
		const s = setup({ exec: seedExec });
		const sessionId = await open(s, "owner-1");
		const h = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "code" })] }), reply({ calls: [call("e", "code_edit", { sessionId, path: ".env", old: "TOKEN=abc", new: "TOKEN=zzz" })] }), reply({ text: "feito" })], { capabilities: [s.cap] });
		const result = await h.run({ ports: { ...h.ports, sandbox: s.sandbox } as Ports, policy: { ...chatPolicy, autonomy: "autonomous" } });
		expect(result.status).toBe("parked");
		expect(s.sandbox.files(sessionId)!.get(".env")).toBe("TOKEN=abc\n");
		const card = h.log.of("card")[0] as { kind: string; request: { toolName: string; riskFacts: { target: string } } };
		expect(card.request).toMatchObject({ toolName: "code_edit", riskFacts: { target: ".env" } });
	});

	it("com a aprovação do dono a escrita do .env acontece uma vez", async () => {
		const s = setup();
		const sessionId = await open(s, "owner-1");
		const args = { sessionId, path: ".env", old: "TOKEN=abc", new: "TOKEN=zzz" };
		const h = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "code" })] }), reply({ calls: [call("e", "code_edit", args)] }), reply({ text: "feito" })], { capabilities: [s.cap] });
		const ports = { ...h.ports, sandbox: s.sandbox } as Ports;
		await h.run({ ports });
		expect(s.sandbox.files(sessionId)!.get(".env")).toBe("TOKEN=abc\n");
		const card = h.log.of("card")[0] as { request: Parameters<typeof grantApproval>[0] };
		const done = await h.run({ ports, input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(done.status).toBe("done");
		expect(s.sandbox.files(sessionId)!.get(".env")).toBe("TOKEN=zzz\n");
	});

	it("edição comum roda direto no chat (write_internal reversível por git)", async () => {
		const s = setup({ exec: seedExec });
		const sessionId = await open(s, "owner-1");
		const h = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "code" })] }), reply({ calls: [call("e", "code_edit", { sessionId, path: "src/price.js", old: "toFixed(2)", new: "toFixed(3)" })] }), reply({ text: "Troquei." })], { capabilities: [s.cap] });
		const result = await h.run({ ports: { ...h.ports, sandbox: s.sandbox } as Ports });
		expect({ status: result.status, stop: (result as { stop?: unknown }).stop }).toMatchObject({ status: "done" });
		expect(s.sandbox.files(sessionId)!.get("src/price.js")).toContain("toFixed(3)");
	});

	it("run sem dono (agenda): a edição e o shell que muda coisa ficam fora; a leitura roda", async () => {
		const s = setup();
		const sessionId = await open(s, "owner-1");
		const agenda = { surface: "agenda" as const, ownerPresent: false, autonomy: "balanced" as const, rules: [] };
		const h = kernelHarness(
			[
				reply({ calls: [call("u", "use_capability", { id: "code" })] }),
				reply({ calls: [call("r", "code_read", { sessionId, path: "src/price.js" }), call("c", "code_shell", { sessionId, cmd: "python3 script.py" })] }),
				reply({ text: "ok" }),
			],
			{ capabilities: [s.cap] },
		);
		await h.run({ ports: { ...h.ports, sandbox: s.sandbox } as Ports, policy: agenda });
		const kinds = s.sandbox.calls.map((c) => c.kind);
		expect(kinds).toContain(CODE_KINDS.read);
		expect(kinds).not.toContain(CODE_KINDS.shell);
	});

	it("economia: 'Bom dia' não carrega o schema do código; o pedido de código carrega no passo 1", async () => {
		const s = setup();
		const bomDia = kernelHarness([reply({ text: "Bom dia!" })], { capabilities: [s.cap] });
		await bomDia.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Bom dia" }] } });
		const first = bomDia.llm.requests[0]!;
		const names = (first.tools ?? []).map((t) => t.name);
		expect(names.filter((n) => n.startsWith("code_"))).toEqual([]);
		expect(JSON.stringify(first.messages)).toContain("code");
		const fix = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "code" })] }), reply({ text: "ok" })], { capabilities: [s.cap] });
		await fix.run({ input: { contextSections: [], history: [{ kind: "owner", text: "corrige o bug no repo acme/loja" }] } });
		expect((fix.llm.requests[0]!.tools ?? []).map((t) => t.name)).toContain("use_capability");
		const second = (fix.llm.requests[1]!.tools ?? []).map((t) => t.name);
		expect(second).toEqual(expect.arrayContaining(["code_session", "code_read", "code_edit", "code_test"]));
	});
});
