// `github_pr_create` (F9): abre um pull request entre duas branches que já existem no repositório, como o app do GitHub do dono.
import { isSafeGitRef } from "@workspace/shared";
import { z } from "zod";
import type { GithubPorts } from "../../ports/github.js";
import { defineTool } from "../../tools/define-tool.js";
import { bodyArg, repoArg, runGithubWrite, titleArg } from "./write-shared.js";

const branch = z.string().trim().min(1).max(200).refine(isSafeGitRef, { message: "a branch name in git ref format (no '..', no spaces, none of ~ ^ : ? * [ \\ #)" });

export function createGithubPrCreateTool(ports: GithubPorts, options: { confirm?: boolean } = {}) {
	return defineTool({
		name: "github_pr_create",
		description:
			"Open a pull request from head into base on a GitHub repository, as the owner's GitHub app. Both branches must already exist in that repository (it cannot create branches or push code, and it does not work from forks). " +
			"Use it when the owner asks to open a pull request for a branch that is already pushed. Do not invent branch names: check them with github_compare or ask the owner. Do not use it to merge (github_pr_merge).",
		inputSchema: z.object({
			repo: repoArg,
			title: titleArg,
			head: branch.describe("Branch with the changes."),
			base: branch.describe("Branch to merge into, usually the default branch."),
			body: bodyArg.optional().describe("Markdown description."),
			draft: z.boolean().optional(),
		}),
		effect: "write_external",
		...(options.confirm && { confirm: "always" as const }),
		riskFacts: ({ repo, head, base }) => ({ target: `GitHub ${repo} (${head} → ${base})` }),
		execute: (args, ctx) => runGithubWrite(ports.githubWrite, ctx, { kind: "pr_create", ...args }, `Pull request "${args.title}" opened`),
	});
}
