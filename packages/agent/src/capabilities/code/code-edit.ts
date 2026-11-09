// `code_edit` (F8.2): troca precisa de um trecho (semântica do `edit_file` do v2, que mora na VM: `docker/dev-sandbox/server/edit-match.mjs`).
// O casamento tolera espaço, indentação e CRLF; mais de um lugar é recusado, salvo `replaceAll`. A capacidade não reimplementa
// o casamento: a VM aplica e devolve o diff, e a recusa chega aqui como erro real com o que fazer.
import { isSensitiveEnvFile, isSensitiveWrite } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

/** Arquivo de segredo ou caminho sensível (CI, auth, deploy, `.env`): o dono aprova a escrita. Sem dono, a tool some. */
export function writeEffect(path: string, text: string): "write_internal" | "credential" {
	return isSensitiveEnvFile(path) || isSensitiveWrite(path, text) ? "credential" : "write_internal";
}

export function createCodeEditTool() {
	return defineTool({
		name: "code_edit",
		description:
			"Replace text in an existing file of the coding workspace. `old` must identify ONE place: matching tolerates whitespace, indentation and CRLF drift, but an ambiguous match is rejected (add surrounding lines, or pass replaceAll: true). " +
			"Read the file first and make minimal edits; the answer shows the diff. Use it for changes to existing files. To create a file use code_write. Editing .env or CI/auth files asks the owner first.",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			path: z.string().min(1).max(500),
			old: z.string().min(1).max(200_000),
			new: z.string().max(200_000),
			replaceAll: z.boolean().optional(),
		}),
		effect: "write_internal",
		effectForArgs: ({ path, new: next }) => writeEffect(path, next),
		riskFacts: ({ path }) => ({ target: path }),
		async execute(args, ctx) {
			assertWorkspacePath(args.path);
			const data = await callCode(ctx, "edit", args, codeResults.edit);
			const parts = [`Edited ${redact(data.path)}: +${data.added} -${data.removed}.`];
			if (data.note) parts.push(redact(data.note));
			if (data.syntaxError) parts.push(`Syntax check failed: ${redact(data.syntaxError)}`);
			parts.push(redact(data.diff));
			return { ok: true, summary: parts.join("\n"), receipt: { what: `Edited ${redact(data.path)} (+${data.added} -${data.removed})`, where: "coding workspace" } };
		},
	});
}
