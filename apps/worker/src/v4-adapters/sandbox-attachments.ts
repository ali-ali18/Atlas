// Tratador do `kind` `attachments.copy` (F9): grava os bytes de um anexo na pasta `anexos` da VM do dono. Entra na tabela
// `defaultSandboxHandlers` (uma linha). O nome já vem saneado da capacidade; aqui se confere de novo (a fronteira não confia).
import { attachmentCopyParams, attachmentCopyResult } from "@workspace/agent";
import type { SandboxKindHandler } from "./sandbox.js";

const FOLDER = "anexos";

/** Nome de um único trecho: sem separadores, sem `..`, sem controle e não vazio. */
function plainName(name: string): boolean {
	if (name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\\")) return false;
	return name.split("").every((char) => char >= " " && char !== "\u007f");
}

export const attachmentCopyHandler: SandboxKindHandler = async (ctx, params) => {
	const parsed = attachmentCopyParams.safeParse(params);
	if (!parsed.success || !plainName(parsed.data.name)) return { ok: false, error: "The file name is not valid for the computer. Use a plain file name." };
	if (!ctx.manager.execWriteFile) return { ok: false, error: "The computer cannot receive files in this version. Tell the owner plainly and offer another way." };
	const written = await ctx.manager.execWriteFile(ctx.sessionId, { path: `${FOLDER}/${parsed.data.name}`, bytes: parsed.data.bytes });
	const confirmed = attachmentCopyResult.safeParse({ path: written.path });
	if (!confirmed.success) return { ok: false, error: "The computer did not confirm the copy." };
	return { ok: true, data: confirmed.data };
};
