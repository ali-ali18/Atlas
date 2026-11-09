// `code_push` (F9): envia a branch ATUAL da sessão ao GitHub. `write_external`: com `confirmWrites` (o dono marcou "confirmar escritas"
// no conector GitHub) pede o dono em toda chamada, como a escrita nativa. Sem argumento de branch: o modelo não escolhe o destino.
// O adaptador recusa a branch padrão, nunca força e mantém a credencial do dono só no ambiente do job.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodePushTool(options: { confirm?: boolean } = {}) {
	return defineTool({
		name: "code_push",
		description:
			"Push the CURRENT branch of the coding workspace to GitHub (the owner's repository). It never forces and never pushes the default branch: commit on a new branch first (code_commit with `branch`). " +
			"Use it after code_commit, when the owner wants the change on GitHub or a pull request. Then open the pull request with code_open_pr. Do not use it for local-only work.",
		inputSchema: z.object({ sessionId: z.string().min(1).max(100) }),
		effect: "write_external",
		...(options.confirm && { confirm: "always" as const }),
		riskFacts: () => ({ target: "GitHub: push of the current branch of the coding session" }),
		async execute(args, ctx) {
			const data = await callCode(ctx, "push", args, codeResults.push);
			const link = data.url ? ` Link: ${redact(data.url)}` : "";
			return {
				ok: true,
				summary: `Branch ${redact(data.branch)} ${data.newBranch ? "created on" : "updated on"} GitHub ${redact(data.repo)}.${link} Next: open the pull request with code_open_pr if the owner asked for one.`,
				receipt: { what: `Pushed branch ${redact(data.branch)}`, where: `GitHub ${redact(data.repo)}`, ...(data.url && { url: redact(data.url) }) },
			};
		},
	});
}
