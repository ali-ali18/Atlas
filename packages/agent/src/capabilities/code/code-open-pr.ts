// `code_open_pr` (F9): abre o pull request da branch já enviada pela ESCRITA NATIVA do GitHub (`githubWrite`, o app do dono; o mesmo
// portão e a mesma regra de confirmação de `github_pr_create`). Repositório, branch e base vêm da SESSÃO do dono (`code.pr_prepare`), nunca
// de argumento do modelo: não dá para abrir PR num repositório que a sessão não tem. Já existe PR aberto da branch? Devolve o link, sem escrever.
import { z } from "zod";
import type { GithubWriter } from "../../ports/github.js";
import { defineTool } from "../../tools/define-tool.js";
import { bodyArg, runGithubWrite, titleArg } from "../github/write-shared.js";
import { callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

const baseArg = z.string().trim().min(1).max(200);

export function createCodeOpenPrTool(writer: GithubWriter | undefined, options: { confirm?: boolean } = {}) {
	return defineTool({
		name: "code_open_pr",
		description:
			"Open a pull request for the CURRENT branch of the coding workspace, after it was pushed with code_push. The repository comes from the session; `base` defaults to the repository's default branch. " +
			"Write the title and a short body in the owner's language: what changed, why, how it was tested. Use it only when the owner asked for a pull request. Not for merging (github_pr_merge) and not for other repositories.",
		inputSchema: z.object({ sessionId: z.string().min(1).max(100), title: titleArg, body: bodyArg.optional(), base: baseArg.optional(), draft: z.boolean().optional() }),
		effect: "write_external",
		...(options.confirm && { confirm: "always" as const }),
		riskFacts: ({ title }) => ({ target: `GitHub pull request "${title}"` }),
		async execute(args, ctx) {
			const facts = await callCode(ctx, "prPrepare", { sessionId: args.sessionId, ...(args.base && { base: args.base }) }, codeResults.prPrepare);
			if (facts.existingPr) {
				return { ok: true, summary: `A pull request is already open for ${redact(facts.head)}: #${facts.existingPr.number} ${redact(facts.existingPr.title)}. Link: ${redact(facts.existingPr.url)}. Nothing new was opened; tell the owner and share the link.` };
			}
			if (facts.head === facts.base) throw new Error(`You are on the base branch (${redact(facts.base)}). Hint: commit on a new branch (code_commit with branch), push it (code_push) and call this again.`);
			if (facts.dirty > 0) throw new Error(`There are ${facts.dirty} uncommitted file(s) that the pull request would not include. Hint: commit them with code_commit and push again (code_push), or tell the owner you are leaving them out.`);
			if (facts.ahead < 1) throw new Error(`The branch has no new commits over ${redact(facts.base)}. Hint: make and commit a change first (code_commit).`);
			if (!facts.pushed) throw new Error("The branch is not on GitHub with its latest commit. Hint: push it first with code_push, then call this again.");
			return runGithubWrite(writer, ctx, { kind: "pr_create", repo: facts.repo, title: args.title, head: facts.head, base: facts.base, ...(args.body !== undefined && { body: args.body }), ...(args.draft !== undefined && { draft: args.draft }) }, `Pull request "${args.title}" opened (${facts.head} → ${facts.base})`);
		},
	});
}
