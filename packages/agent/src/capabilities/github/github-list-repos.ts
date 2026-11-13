// `github_list_repos` (F9): os repositórios do GitHub do dono, mais recentes primeiro, com filtro por trecho do nome. Serve
// para resolver um nome vago ("meu-app") em `owner/name` antes de comparar. É dado PRIVADO do dono e de terceiros (nome do
// repo, quem o criou): `untrusted` + `privateData`, então depois dele uma saída para fora no mesmo run pede aprovação.
import { z } from "zod";
import type { GithubPorts } from "../../ports/github.js";
import { defineTool } from "../../tools/define-tool.js";

export const GITHUB_LIST_REPOS_SHOWN = 20;

export function createGithubListReposTool(ports: GithubPorts) {
	return defineTool({
		name: "github_list_repos",
		description:
			"List the owner's GitHub repositories, most recently pushed first (name, private or public, default branch). Optional query filters by part of the owner/name. " +
			"Use it to turn a vague name (\"my-app\") into the exact owner/name, or to see what the owner has, before github_compare. Do not use it to read files, issues or pull requests. " +
			"If GitHub is not connected it fails: tell the owner plainly to connect GitHub.",
		inputSchema: z.object({
			query: z.string().trim().max(100).optional().describe("Part of the repository name (owner/name), case-insensitive."),
		}),
		effect: "read",
		trust: "untrusted",
		source: "mcp",
		privateData: true,
		ownerData: "connector",
		async execute({ query }, ctx) {
			const all = await ports.github.listRepos(ctx.ownerId, ctx.signal);
			if (ctx.signal?.aborted) throw new Error("Cancelled.");
			const needle = query?.toLowerCase() ?? "";
			const matches = needle ? all.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : all;
			if (matches.length === 0) {
				return { ok: true, summary: needle ? `No repository matches "${query}". Try a shorter part of the name, or list without a filter.` : "No repositories found in the owner's GitHub connection." };
			}
			const shown = [...matches].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "")).slice(0, GITHUB_LIST_REPOS_SHOWN);
			const lines = shown.map((repo, index) => `${index + 1}. ${repo.fullName} (${repo.private ? "private" : "public"}${repo.defaultBranch ? `, default branch ${repo.defaultBranch}` : ""})`);
			const more = matches.length > shown.length ? `\n${matches.length - shown.length} more not shown: narrow it with query.` : "";
			return { ok: true, summary: `Repositories (${shown.length}${matches.length > shown.length ? ` of ${matches.length}` : ""}):\n${lines.join("\n")}${more}` };
		},
	});
}
