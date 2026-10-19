import { getMailboxForBot, prisma } from "@workspace/db";
import type { EffectiveAutonomy } from "@workspace/shared";
import { emailService, type EmailService } from "./service.js";
import type { EmailRunContext } from "./tools.js";

/**
 * Caixa de e-mail do bot para o run (`mailbox: null` = bot sem endereço: só a tool de criar).
 * `sendPolicy` é a autonomia do dono para ENVIAR; num run disparado por e-mail o resto das tools
 * recebe uma autonomia limitada, mas o envio segue esta.
 */
export async function loadEmailRunContext(
	input: { userId: string; botId: string | null | undefined; botName?: string; sendPolicy: EffectiveAutonomy },
	deps: { getMailbox?: typeof getMailboxForBot; service?: EmailService } = {},
): Promise<EmailRunContext | null> {
	if (!input.botId || !input.userId || input.userId === "default") return null;
	const mailbox = await (deps.getMailbox ?? getMailboxForBot)(input.botId, input.userId);
	// Sem endereço o run ainda recebe o contexto (só a tool de criar); desativado: nenhuma tool.
	const botName = input.botName ?? (mailbox ? undefined : (await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { name: true } }).catch(() => null))?.name);
	return { mailbox: mailbox ?? null, botName, service: deps.service ?? emailService, sendPolicy: () => input.sendPolicy };
}
