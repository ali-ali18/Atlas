// `code_read` (F8.2): lê um arquivo em partes. Nada é cortado em silêncio: cada parte diz onde está e como pedir a próxima.
import { isSensitiveEnvFile } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { codeResults } from "./kinds.js";

export function createCodeReadTool() {
	return defineTool({
		name: "code_read",
		description:
			"Read a file from the coding workspace in parts (offset is a 0-based line, limit up to 5000 lines). The answer says which lines it shows and the offset of the next part. " +
			"Use it before editing a file. Reading a secrets file (.env) asks the owner first.",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			path: z.string().min(1).max(500),
			offset: z.number().int().min(0).optional(),
			limit: z.number().int().min(1).max(5000).optional(),
		}),
		effect: "read",
		// .env e parentes: o dono aprova a leitura (e sem dono a tool some).
		effectForArgs: ({ path }) => (isSensitiveEnvFile(path) ? "credential" : "read"),
		riskFacts: ({ path }) => ({ target: path }),
		trust: "untrusted",
		source: "file",
		async execute(args, ctx) {
			assertWorkspacePath(args.path);
			const data = await callCode(ctx, "read", args, codeResults.read);
			if (data.kind === "binary") return { ok: true, summary: `${data.path} is a binary file (${data.note ?? "not shown"}).` };
			const from = data.startLine ?? 1;
			const to = data.endLine ?? from + data.content.split("\n").length - 1;
			const where = data.nextOffset === null ? `end of file (${data.totalLines} lines)` : `more after line ${to}: call code_read again with offset ${data.nextOffset} (${data.totalLines} lines in total)`;
			return { ok: true, summary: `${redact(data.path)} lines ${from}-${to}, ${where}.\n${redact(data.content)}` };
		},
	});
}
