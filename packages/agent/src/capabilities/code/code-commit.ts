// `code_commit` (F9): commit das mudanças da sessão. Local ao workspace (`write_internal`, reversível por git): nada sai do Atlas.
// O adaptador recusa arquivo de segredo no commit (desfaz o stage) e redige a mensagem; aqui só validamos e contamos o que houve.
import { isSafeGitRef } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { assertWorkspacePath, callCode, redact } from "./call.js";
import { writeEffect } from "./code-edit.js";
import { codeResults } from "./kinds.js";

export function createCodeCommitTool() {
	return defineTool({
		name: "code_commit",
		description:
			"Commit the current changes of the coding workspace. Pass `branch` to create a NEW branch for the change first (required when you are on the default branch); optional `paths` commits only those files. " +
			"Write a short, honest commit message in the repository's language and style. Use it after the tests for your change pass, before code_push. It never pushes. Secret files (.env, keys) are refused.",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			message: z.string().trim().min(1).max(5_000),
			branch: z.string().trim().min(1).max(200).refine(isSafeGitRef, { message: "a branch name in git ref format (no '..', no spaces, none of ~ ^ : ? * [ \\ #)" }).optional(),
			paths: z.array(z.string().min(1).max(500)).max(100).optional(),
		}),
		effect: "write_internal",
		// Pedir um caminho sensível explicitamente exige o dono (o adaptador ainda recusa segredo no stage geral).
		effectForArgs: ({ paths }) => ((paths ?? []).some((path) => writeEffect(path, "") === "credential") ? "credential" : "write_internal"),
		riskFacts: ({ branch }) => ({ target: branch ? `new branch ${branch}` : "current branch" }),
		async execute(args, ctx) {
			for (const path of args.paths ?? []) assertWorkspacePath(path);
			const data = await callCode(ctx, "commit", args, codeResults.commit);
			const where = `${data.createdBranch ? "new branch " : "branch "}${redact(data.branch)}`;
			return {
				ok: true,
				summary: `Committed ${data.sha.slice(0, 8)} on ${where}: ${redact(data.subject)} (${data.files} ${data.files === 1 ? "file" : "files"}). Not pushed yet.`,
				receipt: { what: `Commit ${data.sha.slice(0, 8)}: ${redact(data.subject).slice(0, 80)}`, where: "coding workspace" },
			};
		},
	});
}
