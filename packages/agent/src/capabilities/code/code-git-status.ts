// `code_git_status` (F8.2): estado do git da sessão (branch e arquivos alterados). Leitura pura.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodeGitStatusTool() {
	return defineTool({
		name: "code_git_status",
		description: "Show the git state of the coding workspace: current branch and the changed files. Use it to see what you changed before summarizing. For the actual changes use code_diff.",
		inputSchema: z.object({ sessionId: z.string().min(1).max(100) }),
		effect: "read",
		trust: "untrusted",
		source: "file",
		async execute(args, ctx) {
			const data = await callCode(ctx, "gitStatus", args, codeResults.gitStatus);
			if (data.clean) return { ok: true, summary: `Branch ${data.branch ?? "(detached)"}: no changes.` };
			return { ok: true, summary: `Branch ${data.branch ?? "(detached)"}, ${data.files.length} changed:\n${data.files.map((f) => `${f.status} ${redact(f.path)}`).join("\n")}` };
		},
	});
}
