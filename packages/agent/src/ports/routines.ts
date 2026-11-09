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
	/** Resultado da última execução. */
	lastStatus?: "queued" | "running" | "succeeded" | "failed" | "skipped";
};

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
}
