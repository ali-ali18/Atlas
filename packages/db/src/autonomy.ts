import { Prisma } from "@prisma/client";
import {
	parseAutonomyPolicy,
	resolveAutonomy,
	upsertAutonomyException,
	type AutonomyException,
	type AutonomyExpiry,
	type AutonomyPolicy,
	type ResolvedAutonomy,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/**
 * Autonomia do agente (F10): política da conta (`UserSettings.autonomyJson`) e
 * override do bot (`Bot.autonomyJson`, null = herda). A conta é lida SÓ pela
 * linha do próprio usuário (nunca cai na linha legada).
 */

function toJson(policy: AutonomyPolicy | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
	return policy === null ? Prisma.DbNull : (policy as unknown as Prisma.InputJsonValue);
}

/** Bot do usuário. `null` quando é de outra pessoa ou legado sem dono (antes do claim-default). */
async function ownedBot(botId: string, userId: string) {
	return prisma.bot.findFirst({
		where: { id: botId, ownerId: { in: ownerIds(userId) } },
		select: { id: true, name: true, autonomyJson: true },
	});
}

export type AutonomyContext = {
	/** JSON cru como está no banco (base do compare-and-set do vencimento). */
	accountRaw: unknown;
	botRaw: unknown;
	botName: string | null;
};

export async function loadAutonomyContext(input: {
	userId: string;
	botId?: string | null;
}): Promise<AutonomyContext> {
	const [settings, bot] = await Promise.all([
		prisma.userSettings.findUnique({
			where: { userId: input.userId },
			select: { autonomyJson: true },
		}),
		input.botId ? ownedBot(input.botId, input.userId) : Promise.resolve(null),
	]);
	return {
		accountRaw: settings?.autonomyJson ?? null,
		botRaw: bot?.autonomyJson ?? null,
		botName: bot?.name ?? null,
	};
}

export async function getAccountAutonomy(userId: string): Promise<AutonomyPolicy | null> {
	const row = await prisma.userSettings.findUnique({
		where: { userId },
		select: { autonomyJson: true },
	});
	return parseAutonomyPolicy(row?.autonomyJson);
}

export async function setAccountAutonomy(
	userId: string,
	policy: AutonomyPolicy | null,
): Promise<void> {
	await prisma.userSettings.upsert({
		where: { userId },
		create: { userId, autonomyJson: toJson(policy) },
		update: { autonomyJson: toJson(policy) },
	});
}

/** `null` tanto para "herda" quanto para bot que não é do usuário (checar antes com `ownedBot`). */
export async function getBotAutonomy(
	botId: string,
	userId: string,
): Promise<AutonomyPolicy | null | undefined> {
	const bot = await ownedBot(botId, userId);
	if (!bot) return undefined;
	return parseAutonomyPolicy(bot.autonomyJson);
}

/** `false` quando o bot não é do usuário (a rota responde 404). */
export async function setBotAutonomy(
	botId: string,
	userId: string,
	policy: AutonomyPolicy | null,
): Promise<boolean> {
	const bot = await ownedBot(botId, userId);
	if (!bot) return false;
	await prisma.bot.update({ where: { id: bot.id }, data: { autonomyJson: toJson(policy) } });
	return true;
}

/**
 * Acrescenta uma exceção à política do bot (botão "Não perguntar mais para
 * isto"). Sem política própria, cria uma sem `level` (continua herdando).
 * `false` quando o bot não é do usuário.
 */
export async function addBotAutonomyException(input: {
	botId: string;
	userId: string;
	exception: AutonomyException;
}): Promise<boolean> {
	const bot = await ownedBot(input.botId, input.userId);
	if (!bot) return false;
	const current = parseAutonomyPolicy(bot.autonomyJson) ?? { exceptions: [] };
	const next: AutonomyPolicy = {
		...current,
		exceptions: upsertAutonomyException(current.exceptions, input.exception),
	};
	await prisma.bot.update({ where: { id: bot.id }, data: { autonomyJson: toJson(next) } });
	return true;
}

export type LoadedAutonomy = ResolvedAutonomy & {
	botName: string | null;
	/** Vencimentos que ESTA chamada gravou (avisar uma vez só). */
	applied: AutonomyExpiry[];
};

/**
 * Política efetiva do run. Se alguma venceu, grava o fallback (compare-and-set
 * sobre o JSON lido: só quem gravou de fato entra em `applied`, então o aviso
 * no chat sai uma vez só mesmo com runs concorrentes).
 */
export async function loadEffectiveAutonomy(input: {
	userId: string;
	botId?: string | null;
	now: Date;
	/** `false` só resolve (sem gravar o fallback): rotina/webhook não avisam ninguém. */
	applyExpiry?: boolean;
}): Promise<LoadedAutonomy> {
	const ctx = await loadAutonomyContext(input);
	const resolved = resolveAutonomy({ bot: ctx.botRaw, account: ctx.accountRaw, now: input.now });
	const applied: AutonomyExpiry[] = [];
	for (const expiry of input.applyExpiry === false ? [] : resolved.expired) {
		const written =
			expiry.scope === "bot" && input.botId
				? await prisma.bot.updateMany({
						where: { id: input.botId, ownerId: { in: ownerIds(input.userId) }, autonomyJson: { equals: ctx.botRaw as Prisma.InputJsonValue } },
						data: { autonomyJson: toJson(expiry.next) },
					})
				: expiry.scope === "account"
					? await prisma.userSettings.updateMany({
							where: {
								userId: input.userId,
								autonomyJson: { equals: ctx.accountRaw as Prisma.InputJsonValue },
							},
							data: { autonomyJson: toJson(expiry.next) },
						})
					: { count: 0 };
		if (written.count === 1) applied.push(expiry);
	}
	return { ...resolved, botName: ctx.botName, applied };
}
