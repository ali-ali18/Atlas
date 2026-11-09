// Porta `Routines` (F9, parte 1): as rotinas do produto (tabela `routines`, as mesmas que a Biblioteca mostra), para LER e
// CONTROLAR. Não confundir com a agenda do v4 (`Agenda`: lembretes e vigias do próprio motor).
// REGRA: toda chamada leva o `userId` do RUN (nunca do modelo); o bot do run já está dentro do adaptador. Rotina ou grupo de
// outro dono é indistinguível de inexistente (`null`/lista sem ele). Escrita mostra o cartão da rotina no chat (o adaptador
// emite) e sincroniza o agendador; falha real = `throw` com o motivo (a tool devolve `ok:false`).

export type RoutineKind = "cron" | "event" | "once" | "interval";

/** O que o modelo vê de uma rotina. Sem segredo de webhook, sem id interno de gatilho. */
export type RoutineView = {
	id: string;
	name: string;
	/** Gatilho em frase pt-BR ("todo dia às 8h", "Uma vez · 03/10 às 10:00", "A cada 50 min", "e-mail (…)"). */
	trigger: string;
	kind: RoutineKind;
	enabled: boolean;
	/** Nome do grupo (Biblioteca), se tiver. */
	group?: string;
	/** Frase do alerta, se a rotina é um alerta (avisa só quando a condição passa a valer). */
	alert?: string;
	/** O que a rotina faz (instrução resumida). */
	task: string;
	/** ISO. Só quando dá para saber com certeza (uma vez, intervalo); cron e evento ficam sem. */
	nextRunAt?: string;
	/** ISO da última execução. */
	lastRunAt?: string;
	/** Painel que cada execução atualiza no lugar. */
	panelId?: string;
	/** Login do cofre (nome) e site que o dono aprovou para a rotina entrar. Nunca valor. */
	loginAccess?: RoutineLoginAccess;
	/** Resultado da última execução. */
	lastStatus?: "queued" | "running" | "succeeded" | "failed" | "skipped";
};

/** Gatilho já validado pela tool (as regras puras ficam em `capabilities/routines/routine-trigger.ts`); o adaptador só grava. */
export type RoutineTriggerSpec =
	| { kind: "cron"; schedule: string }
	| { kind: "once"; runAt: string }
	| { kind: "interval"; everyMinutes: number }
	| { kind: "email"; fromContains?: string; subjectContains?: string }
	| { kind: "github"; repo: string; events: string[]; prNumber?: number; users?: string[]; branch?: string }
	/** Webhook genérico: URL própria e segredo. O segredo NUNCA passa pelo modelo, nem pelo cartão ao vivo. */
	| { kind: "webhook" };

export type RoutineAlertSpec = { condition: string; hint?: string };

/** O que o dono aprovou para a rotina entrar num site (login do cofre + site normalizado). */
export type RoutineLoginAccess = { login: string; site: string };

export type RoutineCreateSpec = {
	name: string;
	task: string;
	trigger: RoutineTriggerSpec;
	timezone: string;
	/** Nome do grupo (reaproveita o de mesmo nome ou cria). */
	group?: string;
	/** Painel do mesmo bot que cada execução atualiza no lugar. */
	panelId?: string;
	notify?: "always" | "important";
	alert?: RoutineAlertSpec;
	loginAccess?: RoutineLoginAccess;
	enabled: boolean;
};

export type RoutineUpdateSpec = {
	name?: string;
	task?: string;
	trigger?: RoutineTriggerSpec;
	timezone?: string;
	/** `""` tira do grupo. */
	group?: string;
	/** `""` desliga o painel. */
	panelId?: string;
	notify?: "always" | "important";
	/** `null` volta a rotina comum. */
	alert?: RoutineAlertSpec | null;
	/** `null` tira a permissão de login. */
	loginAccess?: RoutineLoginAccess | null;
	enabled?: boolean;
};

/** Resultado de criar/editar. `webhook.url` só em gatilho webhook (sem segredo). */
export type RoutineSaved = { routine: RoutineView; webhook?: { url: string } };

/** Webhook de uma rotina: URL pública SEM segredo. */
export type RoutineWebhookView = { routineId: string; name: string; enabled: boolean; url: string };

/** Ideia de rotina que o bot nota por conta própria (não pedida): cron OU intervalo, nada de gatilho de evento. */
export type RoutineSuggestSpec = {
	name: string;
	task: string;
	trigger: { kind: "cron"; schedule: string } | { kind: "interval"; everyMinutes: number };
	timezone?: string;
};

/** O que aconteceu com a ideia: virou cartão de pergunta, foi criada (modo automático, com "Desfazer") ou não valia (já existe / já foi proposta). */
export type RoutineSuggestOutcome =
	| { status: "proposed" | "created" }
	| { status: "duplicate_routine"; routine: string }
	| { status: "already_proposed"; proposal: "pending" | "accepted" | "declined" };

/** Push avulso ao dono durante um run de rotina marcada "só importante" (o fim do run não avisa sozinho). */
export interface RoutinePush {
	/** Um por run, só ao dono do run, respeitando o horário de silêncio dele. */
	send(text: string): Promise<{ sent: true } | { sent: false; reason: "one_per_run" | "quiet_hours" }>;
}

export type RoutineGroupView = { id: string; name: string; routineCount: number; enabledCount: number };

export interface Routines {
	/** As rotinas do bot do run, deste dono, da mais nova para a mais antiga. */
	list(userId: string): Promise<RoutineView[]>;
	/** Os grupos do bot do run, deste dono. */
	groups(userId: string): Promise<RoutineGroupView[]>;
	/** Pausa ou retoma. `null` = não existe (ou é de outro dono). Mostra o cartão e sincroniza o agendador. */
	setEnabled(userId: string, routineId: string, enabled: boolean): Promise<RoutineView | null>;
	/** Apaga de vez. `null` = não existe (ou é de outro dono). Devolve como era, para o aviso. */
	remove(userId: string, routineId: string): Promise<RoutineView | null>;
	/** Cria um grupo vazio. Lança se o nome já existe ou é inválido. */
	createGroup(userId: string, name: string): Promise<RoutineGroupView>;
	/** Renomeia. `null` = grupo não existe. Lança se o nome já existe ou é inválido. */
	renameGroup(userId: string, groupId: string, name: string): Promise<RoutineGroupView | null>;
	/** Desfaz o grupo; as rotinas ficam, sem grupo. `null` = não existe. */
	deleteGroup(userId: string, groupId: string): Promise<{ name: string; routines: number } | null>;
	/** Pausa ou retoma todas as rotinas do grupo. `null` = não existe. `changed` = quantas mudaram de estado. */
	setGroupEnabled(userId: string, groupId: string, enabled: boolean): Promise<{ name: string; total: number; changed: number } | null>;
	/** Põe a rotina num grupo, ou tira (`groupId` null). `null` = rotina ou grupo não existe. */
	moveToGroup(userId: string, routineId: string, groupId: string | null): Promise<RoutineView | null>;
	/** F9 parte 2. Cria a rotina (já validada), sincroniza o agendador e o webhook do GitHub e mostra o cartão. Lança com o motivo real (caixa de e-mail ausente, GitHub sem acesso, painel que não é do bot, limite de alertas). */
	create(userId: string, spec: RoutineCreateSpec): Promise<RoutineSaved>;
	/** Edita a rotina. `null` = não existe (ou é de outro dono). Mesma sincronização do `create`. */
	update(userId: string, routineId: string, spec: RoutineUpdateSpec): Promise<RoutineSaved | null>;
	/** Webhooks das rotinas do bot (URL sem segredo). */
	webhooks(userId: string): Promise<RoutineWebhookView[]>;
	/**
	 * Sugestão proativa (só bot principal com o modo proativo ligado): grava o cartão "Posso criar esta rotina?" na conversa (ou, no modo
	 * automático, cria a rotina e o cartão tem "Desfazer"). NUNCA cria sozinha no modo "sugerir". Lança com o motivo real quando o modo está desligado.
	 */
	suggest(userId: string, spec: RoutineSuggestSpec, context: { runId: string }): Promise<RoutineSuggestOutcome>;
}
