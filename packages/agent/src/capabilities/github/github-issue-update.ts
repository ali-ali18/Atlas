// `github_issue_update` (F9): edita título, texto, estado ou etiquetas de uma issue existente, como o app do GitHub do dono.
import { z } from "zod";
import type { GithubPorts } from "../../ports/github.js";
import { defineTool } from "../../tools/define-tool.js";
import { bodyArg, issueNumberArg, labelsArg, repoArg, runGithubWrite, titleArg } from "./write-shared.js";

export function createGithubIssueUpdateTool(ports: GithubPorts, options: { confirm?: boolean } = {}) {
	return defineTool({
		name: "github_issue_update",
		description:
			"Edit an existing GitHub issue as the owner's GitHub app: title, text, labels, or close and reopen it (state, with stateReason completed or not_planned when closing). Send only what changes (labels replaces the whole list). " +
			"Use it when the owner asks to close, reopen, rename or relabel an issue. Do not use it to open a new issue (github_issue_create) or to add a comment (github_comment).",
		inputSchema: z.object({
			repo: repoArg,
			number: issueNumberArg,
			title: titleArg.optional(),
			body: bodyArg.optional(),
			state: z.enum(["open", "closed"]).optional(),
			stateReason: z.enum(["completed", "not_planned", "reopened"]).optional(),
			labels: labelsArg.optional(),
		}),
		effect: "write_external",
		...(options.confirm && { confirm: "always" as const }),
		riskFacts: ({ repo, number }) => ({ target: `GitHub ${repo} #${number}` }),
		async execute(args, ctx) {
			const { repo, number, ...changes } = args;
			if (Object.values(changes).every((value) => value === undefined)) throw new Error("Nothing to change. Hint: pass at least one of title, body, state, stateReason or labels.");
			return runGithubWrite(ports.githubWrite, ctx, { kind: "issue_update", repo, number, ...changes }, `Issue #${number} updated`);
		},
	});
}
