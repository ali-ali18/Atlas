// `github_issue_create` (F9): abre uma issue num repositório onde o app do GitHub do dono está instalado.
import { z } from "zod";
import type { GithubPorts } from "../../ports/github.js";
import { defineTool } from "../../tools/define-tool.js";
import { bodyArg, labelsArg, repoArg, runGithubWrite, titleArg } from "./write-shared.js";

export function createGithubIssueCreateTool(ports: GithubPorts, options: { confirm?: boolean } = {}) {
	return defineTool({
		name: "github_issue_create",
		description:
			"Open a new issue on a GitHub repository, as the owner's GitHub app. Use it when the owner asks to open, file or report an issue or a task on a repo. Find the exact owner/name with github_list_repos if you only have a vague name. " +
			"Do not use it to change an existing issue (github_issue_update) or to comment (github_comment). If the app is not installed on that repository it fails and nothing is sent.",
		inputSchema: z.object({
			repo: repoArg,
			title: titleArg,
			body: bodyArg.optional().describe("Markdown text of the issue."),
			labels: labelsArg.optional(),
			assignees: z.array(z.string().trim().min(1).max(39)).max(10).optional().describe("GitHub usernames."),
		}),
		effect: "write_external",
		...(options.confirm && { confirm: "always" as const }),
		riskFacts: ({ repo }) => ({ target: `GitHub ${repo}` }),
		execute: (args, ctx) => runGithubWrite(ports.githubWrite, ctx, { kind: "issue_create", ...args }, `Issue "${args.title}" opened`),
	});
}
