// Peças comuns das tools de ESCRITA do GitHub (F9). A escrita é sempre feita pelo app do GitHub do dono (a conta pessoal nunca
// escreve); o texto que vem do dono (título, corpo) é conteúdo dele, e o que o GitHub devolve é só o link.
import { isSafeGithubRepo } from "@workspace/shared";
import { z } from "zod";
import type { GithubWriteAction, GithubWriteReceipt, GithubWriter } from "../../ports/github.js";
import type { ToolContext } from "../../tools/types.js";

// guard-allow: format-validation owner/name é um identificador, não texto livre
const REPO_PATTERN = new RegExp("^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$");

export const repoArg = z.string().trim().refine((value) => REPO_PATTERN.test(value) && isSafeGithubRepo(value), { message: "use owner/name, for example acme/site" }).describe("owner/name.");
export const issueNumberArg = z.number().int().min(1).max(10_000_000).describe("Issue or pull request number.");
export const titleArg = z.string().trim().min(1).max(256);
export const bodyArg = z.string().max(20_000);
export const labelsArg = z.array(z.string().trim().min(1).max(50)).max(20);

export const WRITE_FAILED_HINT = "Hint: do not retry another way and never ask for a token; if the app is missing, tell the owner to install it in Settings → Connections → GitHub.";

/** Executa a escrita e devolve o resultado honesto (com o link) para o modelo. */
export async function runGithubWrite(writer: GithubWriter | undefined, ctx: ToolContext, action: GithubWriteAction, what: string) {
	if (!writer) throw new Error(`GitHub writing is not available here. ${WRITE_FAILED_HINT}`);
	const receipt: GithubWriteReceipt = await writer.write(ctx.ownerId, action, ctx.signal);
	if (ctx.signal?.aborted) throw new Error("Cancelled.");
	const link = receipt.url ? ` Link: ${receipt.url}` : "";
	return {
		ok: true as const,
		summary: `${what} on ${action.repo}${receipt.number !== null ? ` (#${receipt.number})` : ""}.${link} Tell the owner what was done and share the link.`,
		receipt: { what, where: `GitHub ${action.repo}`, ...(receipt.number !== null && { externalId: String(receipt.number) }), ...(receipt.url && { url: receipt.url }) },
	};
}
