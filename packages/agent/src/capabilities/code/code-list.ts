// `code_list` (F8.2): árvore de arquivos da sessão. Leitura pura.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodeListTool() {
	return defineTool({
		name: "code_list",
		description:
			"List files and folders in the coding workspace (path defaults to the repository root, depth 1 to 6). Use it to find where code lives. To search file contents use code_shell with rg or grep; to read a file use code_read.",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			path: z.string().max(500).optional(),
			depth: z.number().int().min(1).max(6).optional(),
		}),
		effect: "read",
		trust: "untrusted",
		source: "file",
		async execute(args, ctx) {
			if (args.path) assertWorkspacePath(args.path);
			const data = await callCode(ctx, "list", args, codeResults.list);
			const rows = data.entries.map((entry) => `${entry.type === "dir" ? "d" : entry.type === "link" ? "l" : "-"} ${redact(entry.path)}${entry.type === "file" ? ` (${entry.size} B)` : ""}`);
			const more = data.truncated ? `\nShowing ${data.entries.length} of ${data.total}. List a subfolder (path) to see the rest.` : "";
			return { ok: true, summary: data.entries.length === 0 ? `${data.path}: empty.` : `${data.path} (${data.total}):\n${rows.join("\n")}${more}` };
		},
	});
}
