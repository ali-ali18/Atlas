// `code_diff` (F8.2): diff do workspace contra o último commit (ou de um arquivo). Leitura pura.
import { isSensitiveEnvFile } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodeDiffTool() {
	return defineTool({
		name: "code_diff",
		description: "Show the git diff of the coding workspace (all changes, or one file with path; staged: true for staged changes). Use it to review your own work before reporting it. Do not use it to read a whole file (code_read).",
		inputSchema: z.object({ sessionId: z.string().min(1).max(100), path: z.string().max(500).optional(), staged: z.boolean().optional() }),
		effect: "read",
		// Diff de .env mostra o segredo: o dono aprova (e sem dono a tool some), como em code_read.
		effectForArgs: ({ path }) => (path && isSensitiveEnvFile(path) ? "credential" : "read"),
		riskFacts: ({ path }) => ({ target: path ?? "workspace diff" }),
		trust: "untrusted",
		source: "file",
		async execute(args, ctx) {
			if (args.path) assertWorkspacePath(args.path);
			const data = await callCode(ctx, "diff", args, codeResults.diff);
			if (data.empty) return { ok: true, summary: "No changes." };
			const spill = data.spillPath ? `\nThe diff is long: the rest is in ${redact(data.spillPath)} (read it with code_read, in parts).` : "";
			return { ok: true, summary: `${redact(data.diff)}${spill}` };
		},
	});
}
