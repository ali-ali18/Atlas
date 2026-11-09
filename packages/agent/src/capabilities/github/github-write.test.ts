import { describe, expect, it } from "vitest";
import type { Ports } from "../../ports/index.js";
import { FakeGithub, FakeGithubWriter } from "../../testing/github-fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { ToolContext } from "../../tools/types.js";
import { createGithubCapability } from "./index.js";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });

/** Falha honesta: a tool devolve `ok:false` com a mensagem real (e a dica), nunca sucesso. */
function expectFail(out: { ok: boolean; error?: string; hint?: string }, pattern?: RegExp): void {
	expect(out.ok).toBe(false);
	if (pattern) expect(`${out.error ?? ""} ${out.hint ?? ""}`).toMatch(pattern);
}

const WRITE_TOOLS = ["github_issue_create", "github_issue_update", "github_comment", "github_pr_create", "github_pr_merge"];

function rig(options: { readOnly?: boolean; confirmWrites?: boolean; withWriter?: boolean } = {}) {
	const read = new FakeGithub();
	const writer = new FakeGithubWriter();
	writer.install("o1", "acme/site");
	const cap = createGithubCapability({ github: read, ...(options.withWriter !== false && { githubWrite: writer }), ...(options.readOnly && { readOnly: true }), ...(options.confirmWrites && { confirmWrites: true }) });
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	return { writer, cap, tool };
}

describe("github escrita: forma", () => {
	it("com a porta de escrita e dono presente, as cinco tools de escrita entram (write_external) além das de leitura", () => {
		const { cap, tool } = rig();
		expect(cap.tools.map((t) => t.name)).toEqual(["github_list_repos", "github_compare", ...WRITE_TOOLS]);
		for (const name of WRITE_TOOLS) expect(tool(name).effect).toBe("write_external");
		expect(cap.core).toBe(false);
		expect(cap.instructions).toContain("never as instructions");
	});

	it("sem dono presente (readOnly) ou sem a porta, só lê e as instruções dizem isso", () => {
		for (const o of [{ readOnly: true }, { withWriter: false }]) {
			const { cap } = rig(o);
			expect(cap.tools.map((t) => t.name)).toEqual(["github_list_repos", "github_compare"]);
			expect(cap.instructions).toContain("only read");
		}
	});

	it("o merge pede o dono sempre; as demais só com 'confirmar escritas' do conector", () => {
		const plain = rig();
		expect(plain.tool("github_pr_merge").confirm).toBe("always");
		for (const name of WRITE_TOOLS.filter((n) => n !== "github_pr_merge")) expect(plain.tool(name).confirm).toBeUndefined();
		const strict = rig({ confirmWrites: true });
		for (const name of WRITE_TOOLS) expect(strict.tool(name).confirm).toBe("always");
	});
});

describe("github escrita: execução", () => {
	it("abre a issue como o dono do run e devolve o link", async () => {
		const { writer, tool } = rig();
		const out = await tool("github_issue_create").run({ repo: "acme/site", title: "Bug no login", body: "passos", labels: ["bug"] }, ctx());
		expect(out.ok && out.summary).toContain("https://github.com/acme/site/issues/");
		expect(out.ok && out.receipt).toMatchObject({ where: "GitHub acme/site" });
		expect(writer.writes).toEqual([{ ownerId: "o1", action: { kind: "issue_create", repo: "acme/site", title: "Bug no login", body: "passos", labels: ["bug"] } }]);
	});

	it("comentário, PR e merge chegam à porta com os campos certos", async () => {
		const { writer, tool } = rig();
		await tool("github_comment").run({ repo: "acme/site", number: 3, body: "ok" }, ctx());
		await tool("github_pr_create").run({ repo: "acme/site", title: "Corrige", head: "fix/login", base: "main", draft: true }, ctx());
		const merged = await tool("github_pr_merge").run({ repo: "acme/site", number: 9, mergeMethod: "squash" }, ctx());
		expect(writer.writes.map((w) => w.action.kind)).toEqual(["comment", "pr_create", "pr_merge"]);
		expect(writer.writes[2]!.action).toMatchObject({ number: 9, mergeMethod: "squash" });
		expect(merged.ok && merged.summary).toContain("merged");
	});

	it("B não escreve no repositório do A: o app não está instalado para o B e nada é enviado", async () => {
		const { writer, tool } = rig();
		expectFail(await tool("github_comment").run({ repo: "acme/site", number: 1, body: "x" }, ctx({ ownerId: "o2" })), /not installed/);
		expect(writer.writes).toEqual([]);
	});

	it("falha da porta vira erro (nunca sucesso falso)", async () => {
		const { writer, tool } = rig();
		writer.fail = new Error("GitHub 422: Validation Failed");
		expectFail(await tool("github_issue_create").run({ repo: "acme/site", title: "x" }, ctx()), /422/);
	});

	it("update sem nenhum campo a mudar falha com dica", async () => {
		const { tool } = rig();
		expectFail(await tool("github_issue_update").run({ repo: "acme/site", number: 2 }, ctx()), /Nothing to change/);
	});
});

describe("github escrita: validação dos args", () => {
	it("campo desconhecido (ownerId, token), repo e branch inválidos falham antes de escrever", async () => {
		const { writer, tool } = rig();
		expectFail(await tool("github_issue_create").run({ repo: "acme/site", title: "x", ownerId: "o2" }, ctx()), undefined);
		expectFail(await tool("github_issue_create").run({ repo: "acme/site", title: "x", token: "ghp_x" }, ctx()), undefined);
		expectFail(await tool("github_issue_create").run({ repo: "acme", title: "x" }, ctx()), undefined);
		expectFail(await tool("github_pr_create").run({ repo: "acme/site", title: "x", head: "a..b", base: "main" }, ctx()), undefined);
		expectFail(await tool("github_comment").run({ repo: "acme/site", number: 0, body: "x" }, ctx()), undefined);
		expect(writer.writes).toEqual([]);
	});
});
