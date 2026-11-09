// `code_session` (F8.2): abre ou retoma a sessão de código (container com o repositório clonado). Sem ela, nenhuma outra
// tool `code_*` funciona. Efeito `read`: só prepara um workspace descartável (clone), nada do dono muda; o modo plano precisa disso para ler.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodeSessionTool() {
	return defineTool({
		name: "code_session",
		description:
			"Open a coding session: a private workspace with the repository cloned (repo as owner/name, optional branch), or resume one by sessionId. " +
			"Use it first, before reading or editing code. Reuse the sessionId it returns in every other code_* tool. Do not use it for plain questions about code the owner pasted in the chat.",
		inputSchema: z.object({
			repo: z.string().min(3).max(200).optional().describe("GitHub repository as owner/name."),
			branch: z.string().min(1).max(200).optional().describe("Branch to work on; created from the default branch if it does not exist."),
			sessionId: z.string().min(1).max(100).optional().describe("Resume this session instead of opening a new one."),
		}),
		// `read`: abrir a sessão só prepara um workspace descartável (clone); nada do dono muda. Assim o modo plano também consegue olhar o código.
		effect: "read",
		async execute(args, ctx) {
			const data = await callCode(ctx, "session", args, codeResults.session);
			const lines = [`Session ${data.sessionId} ready${data.repo ? ` on ${data.repo}` : ""}${data.branch ? ` (branch ${data.branch})` : ""}.`];
			if (data.testCommand) lines.push(`Fast test command: ${data.testCommand}`);
			if (data.note) lines.push(redact(data.note));
			return { ok: true, summary: lines.join(" ") };
		},
	});
}
