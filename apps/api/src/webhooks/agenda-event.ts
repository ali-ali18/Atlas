// E-mail recebido na caixa do bot acorda as intenções da agenda do v4 ("quando chegar o e-mail tal, faço Y", F7.1).
//
// Roda DEPOIS da assinatura, da idempotência e da lista de permitidos (só chega aqui remetente permitido, primeira entrega).
// Não cria run: marca as intenções do dono, daquele bot, que o filtro estrutural (remetente, assunto, anexo) aceita; a varredura
// do worker (`claimPendingEventItems`) acorda cada uma quando o run anterior terminou, respeitando o espaçamento mínimo e o
// teto diário. Assim vale com várias instâncias e sem fila nova. O run de agenda lê a caixa (`email_list`): a marca não guarda
// o conteúdo. Só para quem tem o motor v4 ligado (conta na flag E bot que o escolhe), com a mesma decisão do worker.
import { prisma, queueAgendaEventWakes } from "@workspace/db";
import { AGENDA_EVENT_MIN_GAP_MINUTES, chooseRunEngine, isEngineV4Enabled, readEngineDefault, readEnginePolicy, readEngineV4Gate, type AgendaEvent, type EngineDefault, type EngineV4Gate } from "@workspace/shared";

export type EmailIntentWakeDeps = {
	gate(): EngineV4Gate;
	engineDefault(): EngineDefault;
	/** Bot do dono (escopo na consulta). */
	loadBot(userId: string, botId: string): Promise<{ policyJson?: unknown } | null>;
	queue: typeof queueAgendaEventWakes;
	now?: () => Date;
};

export const realEmailIntentWakeDeps: EmailIntentWakeDeps = {
	gate: () => readEngineV4Gate(process.env.ATLAS_ENGINE_V4, process.env.ATLAS_ENGINE_V4_ACCOUNTS),
	engineDefault: () => readEngineDefault(process.env.ATLAS_ENGINE_V2_DEFAULT),
	loadBot: (userId, botId) => prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { policyJson: true } }),
	queue: queueAgendaEventWakes,
};

export type EmailIntentWake = { marked: number; skipped?: "v4_off" | "no_bot" | "engine_not_v4" };

export async function wakeIntentsForEmail(input: { userId: string; botId: string; event: AgendaEvent }, deps: EmailIntentWakeDeps = realEmailIntentWakeDeps): Promise<EmailIntentWake> {
	const gate = deps.gate();
	// Sem v4 ligado para a conta nada acontece (e nem consulta o banco).
	if (!isEngineV4Enabled(gate, input.userId)) return { marked: 0, skipped: "v4_off" };
	const bot = await deps.loadBot(input.userId, input.botId);
	if (!bot) return { marked: 0, skipped: "no_bot" };
	// A mesma escolha de motor que o worker faz ao acordar o item: se o bot está fixado em outro motor, o item não rodaria.
	const engine = chooseRunEngine({ policy: readEnginePolicy(bot.policyJson), origin: "proactive", isGroupRun: false, globalDefault: deps.engineDefault(), userId: input.userId, v4Gate: gate, agenda: true });
	if (engine !== "v4") return { marked: 0, skipped: "engine_not_v4" };
	const { marked } = await deps.queue({ userId: input.userId, botId: input.botId, event: input.event, now: (deps.now ?? (() => new Date()))(), minGapMinutes: AGENDA_EVENT_MIN_GAP_MINUTES });
	return { marked };
}
