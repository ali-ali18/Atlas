// `code_write` (F8.2): cria ou sobrescreve um arquivo inteiro do workspace.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { writeEffect } from "./code-edit.js";
import { codeResults } from "./kinds.js";

export function createCodeWriteTool() {
	return defineTool({
		name: "code_write",
		description:
			"Create a new file, or fully overwrite one, in the coding workspace (parent folders are created). Prefer code_edit for changes to an existing file: it is smaller and safer. " +
			"Writing .env or CI/auth files asks the owner first.",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			path: z.string().min(1).max(500),
			content: z.string().max(2_000_000),
		}),
		effect: "write_internal",
		effectForArgs: ({ path, content }) => writeEffect(path, content),
		riskFacts: ({ path }) => ({ target: path }),
		async execute(args, ctx) {
			assertWorkspacePath(args.path);
			const data = await callCode(ctx, "write", args, codeResults.write);
			const head = `${data.created ? "Created" : "Overwrote"} ${redact(data.path)} (${data.bytes} B, +${data.added} -${data.removed}).`;
			return { ok: true, receipt: { what: `${data.created ? "Created" : "Overwrote"} ${redact(data.path)}`, where: "coding workspace" }, summary: [head, data.syntaxError && `Syntax check failed: ${redact(data.syntaxError)}`, redact(data.diff)].filter(Boolean).join("\n") };
		},
	});
}
