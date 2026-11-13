// Escolha da conta de e-mail de uma chamada. Usada pelas cinco tools: a regra é uma só.
// Com uma conta só, ela é a padrão; com Gmail e caixa do bot, quem ler/escrever precisa dizer qual (listar e triar juntam as duas).
import { type EmailSourceId, EMAIL_SOURCES } from "@workspace/shared";
import { z } from "zod";
import type { EmailAccount, EmailAccountInfo, EmailPorts } from "../../ports/email.js";

export const sourceField = z.enum(EMAIL_SOURCES).optional().describe("Which account: gmail (the owner's Gmail) or bot (the bot's own mailbox). Omit when only one is connected.");

const NOTHING_CONNECTED = "No e-mail account is connected. Hint: tell the owner plainly that they can connect Gmail in Apps, or give the bot its own address in the bot's E-mail settings.";

export async function listAccounts(ports: Pick<EmailPorts, "accounts">, userId: string): Promise<EmailAccountInfo[]> {
	const accounts = await ports.accounts.list(userId);
	if (accounts.length === 0) throw new Error(NOTHING_CONNECTED);
	return accounts;
}

async function openOrThrow(ports: Pick<EmailPorts, "accounts">, userId: string, source: EmailSourceId, available: readonly EmailAccountInfo[]): Promise<EmailAccount> {
	const account = available.some((info) => info.source === source) ? await ports.accounts.open(userId, source) : null;
	if (!account) throw new Error(`The ${source === "gmail" ? "Gmail" : "bot mailbox"} account is not connected. Hint: connected accounts: ${available.map((info) => info.source).join(", ")}.`);
	return account;
}

/** Contas a consultar: a pedida, ou todas as conectadas. */
export async function accountsFor(ports: Pick<EmailPorts, "accounts">, userId: string, source: EmailSourceId | undefined): Promise<EmailAccount[]> {
	const available = await listAccounts(ports, userId);
	const wanted = source ? [source] : available.map((info) => info.source);
	return Promise.all(wanted.map((id) => openOrThrow(ports, userId, id, available)));
}

/** Uma conta só (ler, rascunhar, enviar): a pedida, a única conectada ou erro pedindo `source`. */
export async function singleAccount(ports: Pick<EmailPorts, "accounts">, userId: string, source: EmailSourceId | undefined): Promise<EmailAccount> {
	const available = await listAccounts(ports, userId);
	if (source) return openOrThrow(ports, userId, source, available);
	if (available.length > 1) throw new Error(`Several e-mail accounts are connected (${available.map((info) => info.source).join(", ")}). Hint: pass source.`);
	return openOrThrow(ports, userId, available[0]!.source, available);
}
