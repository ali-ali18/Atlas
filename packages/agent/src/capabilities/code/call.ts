// Chamada à porta `Sandbox` com validação do que volta e texto sempre redigido. Um lugar só: nenhuma tool da capacidade
// fala com a porta nem formata saída sem passar por aqui (segredo na saída do shell/arquivo nunca chega ao modelo).
import { redactSecrets } from "@workspace/shared";
import type { z } from "zod";
import type { ToolContext } from "../../tools/types.js";
import { CODE_KINDS, type CodeKind, type codeParams, type codeResults } from "./kinds.js";

type Key = keyof typeof codeResults;
const KIND_OF: Record<Key, CodeKind> = {
	session: CODE_KINDS.session,
	list: CODE_KINDS.list,
	read: CODE_KINDS.read,
	edit: CODE_KINDS.edit,
	write: CODE_KINDS.write,
	shell: CODE_KINDS.shell,
	test: CODE_KINDS.test,
	gitStatus: CODE_KINDS.gitStatus,
	diff: CODE_KINDS.diff,
};

export const redact = (text: string): string => redactSecrets(text);

export async function callCode<K extends Key>(ctx: ToolContext, key: K, params: z.input<(typeof codeParams)[K]>, schema: z.ZodType<z.infer<(typeof codeResults)[K]>>): Promise<z.infer<(typeof codeResults)[K]>> {
	const result = await ctx.ports.sandbox.run(ctx.ownerId, { kind: KIND_OF[key], params }, ctx.signal);
	if (!result.ok) throw new Error(redact(result.error ?? "The code environment failed without a message."));
	const parsed = schema.safeParse(result.data);
	if (!parsed.success) throw new Error(`The code environment returned an unexpected answer for ${KIND_OF[key]}.`);
	return parsed.data;
}

/** Caminho do workspace: relativo ou sob /workspace, sem `..`, sem NUL. A VM ainda confere (path guard); aqui falha cedo e claro. */
export function workspacePathError(path: string): string | null {
	if (path.includes("\0")) return "The path has an invalid character.";
	if (path.split(/[\\/]/).includes("..")) return 'The path cannot contain "..". Use a path inside the workspace.';
	if (path.startsWith("/") && path !== "/workspace" && !path.startsWith("/workspace/")) return "Only paths inside /workspace are allowed.";
	return null;
}

export function assertWorkspacePath(path: string): void {
	const error = workspacePathError(path);
	if (error) throw new Error(error);
}
