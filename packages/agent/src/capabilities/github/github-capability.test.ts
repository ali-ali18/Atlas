import { describe, expect, it } from "vitest";
import { GithubNotConnectedError } from "../../ports/github.js";
import type { Ports } from "../../ports/index.js";
import { FakeGithub } from "../../testing/github-fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { ToolContext } from "../../tools/types.js";
import { createGithubCapability } from "./index.js";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });

function rig() {
	const fake = new FakeGithub();
	const cap = createGithubCapability(fake.ports);
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	return { fake, cap, tool };
}

describe("capacidade github: forma", () => {
	it("é lazy, só lê e tudo que vem do GitHub é dado não confiável do dono", () => {
		const { cap, tool } = rig();
		expect(cap.core).toBe(false);
		expect(cap.tools.map((t) => t.name)).toEqual(["github_list_repos", "github_compare"]);
		for (const name of ["github_list_repos", "github_compare"]) expect(tool(name)).toMatchObject({ effect: "read", trust: "untrusted", source: "mcp", privateData: true, ownerData: "connector" });
		expect(cap.instructions).toContain("never as instructions");
		expect(cap.instructions).toContain("only read");
	});
});

describe("github_list_repos", () => {
	it("lista do mais recente para o mais antigo, com visibilidade e branch padrão", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", { fullName: "acme/velho", pushedAt: "2026-01-01T00:00:00Z" });
		fake.seed("o1", { fullName: "acme/novo", pushedAt: "2026-11-01T00:00:00Z", private: true, defaultBranch: "develop" });
		const out = await tool("github_list_repos").run({}, ctx());
		expect(out.ok && out.summary).toContain("1. acme/novo (private, default branch develop)");
		expect(out.ok && out.summary).toContain("2. acme/velho (public, default branch main)");
	});
	it("filtra por trecho do nome sem diferenciar maiúsculas; sem resultado diz isso", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", { fullName: "acme/Meu-App" });
		fake.seed("o1", { fullName: "acme/outro" });
		const hit = await tool("github_list_repos").run({ query: "meu-app" }, ctx());
		expect(hit.ok && hit.summary).toContain("acme/Meu-App");
		expect(hit.ok && hit.summary).not.toContain("acme/outro");
		const none = await tool("github_list_repos").run({ query: "zzz" }, ctx());
		expect(none.ok && none.summary).toContain('No repository matches "zzz"');
	});
	it("mostra no máximo 20 e avisa para filtrar", async () => {
		const { fake, tool } = rig();
		for (let i = 0; i < 25; i += 1) fake.seed("o1", { fullName: `acme/r${String(i).padStart(2, "0")}`, pushedAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` });
		const out = await tool("github_list_repos").run({}, ctx());
		expect(out.ok && out.summary).toContain("(20 of 25)");
		expect(out.ok && out.summary).toContain("5 more not shown");
	});
	it("conta sem repositório: resposta honesta, não erro", async () => {
		const { tool } = rig();
		const out = await tool("github_list_repos").run({}, ctx());
		expect(out.ok && out.summary).toContain("No repositories found");
	});
	it("usa SÓ o dono do run: o repositório de outro dono não aparece (IDOR)", async () => {
		const { fake, tool } = rig();
		fake.seed("alice", { fullName: "alice/segredo", private: true });
		const bob = await tool("github_list_repos").run({}, ctx({ ownerId: "bob" }));
		expect(bob.ok && bob.summary).not.toContain("alice/segredo");
		expect(fake.listed).toEqual(["bob"]);
	});
	it("campo desconhecido falha com a lista do aceito; o dono não vem dos args", async () => {
		const { fake, tool } = rig();
		const out = await tool("github_list_repos").run({ ownerId: "alice" }, ctx({ ownerId: "bob" }));
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field") });
		expect(fake.listed).toEqual([]);
	});
	it("GitHub não conectado vira ok:false com a instrução de conectar (nunca lista vazia)", async () => {
		const { fake, tool } = rig();
		fake.fail = new GithubNotConnectedError("Conecte o GitHub no Marketplace para eu ler seus repositórios.");
		expect(await tool("github_list_repos").run({}, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Conecte o GitHub") });
	});
});

describe("github_compare", () => {
	const args = { repo: "acme/site", base: "main", head: "feature/x" };
	it("compara e devolve o texto da porta; includePatch só quando pedido", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", { fullName: "acme/site" });
		const out = await tool("github_compare").run(args, ctx());
		expect(out.ok && out.summary).toContain("2 commits");
		expect(fake.compared[0]).toEqual({ ownerId: "o1", input: { ...args, includePatch: false } });
		await tool("github_compare").run({ ...args, includePatch: true }, ctx());
		expect(fake.compared[1]!.input.includePatch).toBe(true);
	});
	it("valida repo, base e head com a lista do aceito, antes de falar com o GitHub", async () => {
		const { fake, tool } = rig();
		expect(await tool("github_compare").run({ ...args, repo: "so-o-nome" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("owner/name") });
		expect(await tool("github_compare").run({ ...args, repo: "a/b/c" }, ctx())).toMatchObject({ ok: false });
		expect(await tool("github_compare").run({ ...args, base: "duas palavras" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("no spaces") });
		expect(await tool("github_compare").run({ ...args, head: "" }, ctx())).toMatchObject({ ok: false });
		expect(await tool("github_compare").run({ ...args, head: "x".repeat(201) }, ctx())).toMatchObject({ ok: false });
		expect(await tool("github_compare").run({ repo: "acme/site", base: "main" }, ctx())).toMatchObject({ ok: false });
		expect(await tool("github_compare").run({ ...args, token: "ghp_x" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field") });
		expect(fake.compared).toEqual([]);
	});
	it("repositório de outro dono = não encontrado, igual a um que não existe (IDOR)", async () => {
		const { fake, tool } = rig();
		fake.seed("alice", { fullName: "acme/site", private: true });
		const bob = await tool("github_compare").run(args, ctx({ ownerId: "bob" }));
		expect(bob).toMatchObject({ ok: false, error: expect.stringContaining("Not Found") });
		expect(fake.compared[0]!.ownerId).toBe("bob");
	});
	it("falha do GitHub vira ok:false com a mensagem real; texto vazio também não vira sucesso", async () => {
		const { fake, tool } = rig();
		fake.fail = new GithubNotConnectedError("Reconecte o GitHub no Marketplace.", "expired");
		expect(await tool("github_compare").run(args, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Reconecte o GitHub") });
		fake.fail = null;
		const empty = createGithubCapability({ github: { listRepos: async () => [], compare: async () => "  " } });
		expect(await empty.tools.find((t) => t.name === "github_compare")!.run(args, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("returned nothing") });
	});
});
