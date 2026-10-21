import { AVATAR_COLORS, eyeColorFor as engineEyeColorFor } from "@workspace/ui/lib/avatar/identity";
import type { MessageSource, BotLanguage, BotNeed, BotProposalData, DevApprovalCardInfo, LoginConnector, LoginVaultOffer, RoutineProposalMode, RoutineProposalSpec, RoutineProposalStatus, SkillProposalData, SubagentTaskView, ChartSpec } from "@workspace/shared";
import type { BotProfileProposal } from "@/components/ai-elements/confirm";

export type BodyColor = {
	name: string;
	value: string;
};

// Paleta do motor de avatar: tons chapados com bom contraste para olhos escuros.
export const bodyColors: BodyColor[] = AVATAR_COLORS.map(({ name, value }) => ({ name, value }));

/** Rostos pedidos por nome (os nomes vêm do desenho antigo; o motor traduz). */
export type BloubState =
	| "attentif"
	| "blase"
	| "colere"
	| "confus"
	| "curieux"
	| "effraye"
	| "excite"
	| "fier"
	| "heureux"
	| "hilare"
	| "mefiant"
	| "neutre"
	| "somnolent"
	| "surpris"
	| "timide"
	| "triste"
	| "yeux_ecarquilles";

export const defaultBodyColor = "#FF6700";
export const defaultBotShape = "blob";
export const defaultEyeColor = "#0a0a0c";

export const agentStates: BloubState[] = [
	"curieux",
	"attentif",
	"heureux",
	"hilare",
	"excite",
	"fier",
	"surpris",
	"mefiant",
	"neutre",
	"timide",
	"blase",
	"confus",
	"colere",
	"effraye",
	"triste",
	"somnolent",
];

// Todas as expressões disponíveis (chaves de `bloubStates`/`bloubPoses`),
// exceto "somnolent" — dormir enquanto trabalha seria contraditório.
// É a lista usada para variar o rosto SOMENTE durante o trabalho.
export const workingAgentStates: BloubState[] = [
	"curieux",
	"attentif",
	"heureux",
	"hilare",
	"excite",
	"fier",
	"surpris",
	"mefiant",
	"neutre",
	"timide",
	"blase",
	"confus",
	"colere",
	"effraye",
	"triste",
];

// Repouso é sempre neutro: sidebar, rail, fixados e header não trocam
// de expressão por hover/seleção/tempo. Mantido para compatibilidade.
export const idleAgentStates: BloubState[] = ["neutre"];

// Sorteia um item da lista, com fallback seguro para o primeiro elemento.
export function randomFrom<T>(list: readonly T[]): T {
	const item = list[Math.floor(Math.random() * list.length)];
	return item ?? list[0]!;
}

/** @deprecated Repouso agora é sempre "neutre"; mantido para compat. */
export function randomAgentState(): BloubState {
	return "neutre";
}

// Sorteia uma expressão de trabalho, evitando repetir a mesma em sequência.
export function randomWorkingState(previous?: BloubState): BloubState {
	if (workingAgentStates.length === 0) return "neutre";
	if (workingAgentStates.length === 1) return workingAgentStates[0]!;
	let next = randomFrom(workingAgentStates);
	if (previous !== undefined) {
		let guard = 0;
		while (next === previous && guard < 5) {
			next = randomFrom(workingAgentStates);
			guard += 1;
		}
	}
	return next;
}

// Olho sempre escuro, exceto em corpo (quase) preto, onde fica claro.
export const eyeColorFor = engineEyeColorFor;

export type Agent = {
	color: string;
	conversationId?: string;
	description?: string;
	id: string;
	language?: BotLanguage;
	lastMessage?: string | null;
	members?: string[];
	name: string;
	/** Bolinha de não lida (vem do servidor); NÃO é a chave de notificações push, que é `notify`. */
	notifications?: boolean;
	/** Notificações push deste bot (switch "Notificações"); ausente = ligado. */
	notify?: boolean;
	/** Estado de leitura vindo do servidor (a bolinha de notificação sai daqui). */
	unreadCount?: number;
	firstUnreadMessageId?: string | null;
	manualUnread?: boolean;
	openRouterModel?: string;
	pinOrder?: number;
	pinned?: boolean;
	/** "Bot principal" da conta: coordena e delega aos outros. */
	isPrimary?: boolean;
	/** Id da sessão (seção) na sidebar; ausente = "Sem sessão". */
	sectionId?: string | null;
	/** Forma do corpo (ids do motor ou os antigos, ex.: "rond"). Sem valor, sai do id. */
	shape?: string;
	snippet: string;
	state?: BloubState;
	/** ISO da última mensagem; a lista formata "agora"/hora/dia a partir dele. */
	lastMessageAt?: string | null;
	time: string;
};

export type NewBotInput = {
	name: string;
	color?: string;
	shape?: string;
};

/** Novo grupo: nome, 2+ membros (ids de bots) e cor opcional. */
export type NewGroupInput = {
	name: string;
	memberIds: string[];
	color?: string;
};

export type ScheduleState = {
	frequency: string;
	time: string;
	minute: string;
	weekday: string;
	monthDay: string;
	intervalValue: string;
	intervalUnit: string;
	month: string;
	days: string;
	cadence: string;
	everyValue: string;
	everyUnit: string;
	from: string;
	to: string;
	expression: string;
};

export type RoutineTrigger = {
	id: string;
	schedule?: ScheduleState;
	text: string;
};

import type {
	GithubTriggerEvent,
	GithubTriggerState,
} from "@workspace/shared";

/** Config do gatilho GitHub (distinto do conector MCP GitHub que o bot usa). */
export type RoutineGithubUiConfig = {
	repo: string;
	events: GithubTriggerEvent[];
	/** Babá de um PR específico; vazio = não filtra. */
	prNumber: string;
	/** Filtro de autor/ator, vírgula-separado; vazio = não filtra (CI é sempre isento). */
	users: string;
	/**
	 * Filtro de branch (sem PR): ci_* = branch do check suite (obrigatória
	 * quando algum evento ci_* está selecionado e não há PR); push = branch do
	 * push; pr_* = branch BASE/destino do PR. Generalização de `ciBranch`.
	 * Opcional só pra `routine-editor.tsx` (ainda não migrado) continuar
	 * compilando sem informar este campo — sempre presente vindo de
	 * `recordToUiRoutine`.
	 */
	branch?: string;
	/** @deprecated alias de `branch` (nome anterior à generalização) — mantido só até routine-editor.tsx migrar; mesmo valor de `branch`. */
	ciBranch: string;
	state?: GithubTriggerState;
};

export type Routine = {
	active: boolean;
	/** "bot" = criada pelo bot no modo proativo (selo "Criada pelo bot"). */
	createdBy?: "user" | "bot";
	/** Grupo da rotina (`null` = tirar do grupo; ausente = sem grupo). */
	groupId?: string | null;
	id: string;
	instruction: string;
	name: string;
	/** Id do modelo desta rotina. */
	model: string;
	allowChatgptPlan?: boolean;
	/** cron = agendamento; event = webhook/github; once = lembrete de uma vez só; interval = a cada N min. */
	triggerKind: "cron" | "event" | "once" | "interval";
	triggers: RoutineTrigger[];
	hook?: {
		hookKey: string;
		url: string;
		/** Só GitHub: link pronto pra cadastrar o webhook no repo. */
		setupUrl?: string;
		/** A integração autenticou com ?secret= na URL recentemente (recomendar o cabeçalho). */
		urlSecretAt?: string;
	};
	github?: RoutineGithubUiConfig;
};

export const initialAgents: Agent[] = [
	{
		id: "orquestrador",
		name: "Orquestrador",
		snippet: "Projeto localhost:8536 e referências",
		time: "agora",
		color: "#f44336",
	},
	{
		id: "coder-fork",
		name: "Coder Fork",
		snippet: "Agente do Cursor · preview mobile",
		time: "09:09",
		color: "#2196f3",
	},
	{
		id: "guerreiro",
		name: "Agente do Guerreiro",
		snippet: "Projeto Agentes4u · preview mobile",
		time: "00:29",
		color: "#e91e63",
	},
	{
		id: "coder",
		name: "coder",
		snippet: "Developer backend · erros e logs",
		time: "09:09",
		color: "#009688",
	},
	{
		id: "cyber",
		name: "Cyber",
		snippet: "Crews e PRs · cofre de contatos",
		time: "23:06",
		color: "#fdd835",
		notifications: true,
	},
	{
		id: "principal",
		name: "Principal",
		snippet: "Reunião de nota · reimplantar no host",
		time: "08:08",
		color: "#4caf50",
	},
	{
		id: "aurelia",
		name: "Aurélia de Andrade",
		snippet: "Projeto Agentes4u · referências",
		time: "03:48",
		color: "#9c27b0",
	},
];

import type { SkillListItemData } from "@workspace/shared";
import type { RoutineListItemData } from "@workspace/shared";

export type QuestionnaireChoiceData = {
	value: string;
	label?: string;
	description?: string;
};

export type QuestionnaireItemData = {
	name: string;
	prompt: string;
	description?: string;
	required?: boolean;
	multiple?: boolean;
	choices?: QuestionnaireChoiceData[];
	input?: {
		label: string;
		placeholder?: string;
	};
};

export type QuestionnaireStatus = "pending" | "submitted" | "dismissed";

/** Respostas consolidadas no submit (nome -> valor(es)). */
export type QuestionnaireAnswersData = Record<string, string | string[]>;

/** `createdAt` (ISO): hora local ao criar, depois a do servidor; alimenta os separadores de horário. */
export type Message = MessageVariant & { createdAt?: string };

/**
 * Mensagem de conversa entre bots. `request` = pedido de outro bot (chega no destino),
 * `reply` = resposta do destino (chega no remetente), `answer` = fala do próprio bot
 * ao atender um pedido.
 */
/** Autor de uma fala na conversa de um grupo (o membro que a escreveu). */
export type MessageAuthor = { id?: string; name: string };

export type BotTag = {
	kind: "request" | "reply" | "answer";
	fromBotId?: string;
	fromBotName?: string;
	botMessageId?: string;
};

type MessageVariant =
	| { id: string; kind: "assistant"; text: string; bot?: BotTag; author?: MessageAuthor; runSource?: MessageSource; /** Run que gravou a fala (inspetor). */ runId?: string }
	| { id: string; kind: "bot-link"; botId: string; botName: string; title: string; botMessageId?: string }
	| { id: string; kind: "needs-user"; botId: string; botName: string; title: string; botMessageId: string; need: BotNeed; status: "pending" | "resolved" }
	| { id: string; kind: "auto-decision"; botId: string; botName: string; decision: "approved" | "rejected" | "answered"; note: string; subject: string; reason: string; status: "queued" | "applied" | "failed" }
	| { id: string; kind: "images"; source: "user" | "assistant"; items: Array<{ artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string }> }
	| { id: string; kind: "attachment"; meta: string; name: string }
	| { id: string; kind: "tool"; label: string; text: string }
	| { id: string; kind: "user"; text: string; bot?: BotTag; /** E-mail recebido pelo bot: o texto é o corpo; a UI mostra um cartão. */ email?: { from: string; subject: string; threadId: string } }
	| {
			id: string;
			kind: "confirm";
			title: string;
			description?: string;
			status?: "pending" | "approved" | "rejected" | "failed";
			/** Motivo da falha (status "failed"): o erro que a ação devolveu ao executar. */
			failureDetail?: string;
			confirmLabel?: string;
			cancelLabel?: string;
			/** "Não perguntar mais para isto" (só escrita reversível de conector). */
			alwaysLabel?: string;
			/** Aprovação de comando/escrita de sessão de código (card próprio). */
			devApproval?: DevApprovalCardInfo;
			secretsRequest?: import("@workspace/shared").SecretsRequestInfo;
			emailKeyRequest?: import("@workspace/shared").EmailKeyRequestInfo;
			/** Escrita no GitHub bloqueada: cartão com "Instalar o app" / "Usar minha conta desta vez". */
			githubIdentity?: import("@workspace/shared").GithubIdentityCardInfo;
			/** Plano proposto (`propose_plan`): cartão próprio com passos numerados e "Aprovar plano". */
			plan?: import("@workspace/shared").PlanInfo;
			/** Desfecho gravado no cartão (`outcome.detail`): diferencia "ajuste pedido" de "cancelado" no plano. */
			planOutcome?: string;
			confirmId?: string;
			/** Um pedido mais novo da mesma conversa substituiu este (o servidor o recusou): aparece como "Expirado". */
			superseded?: boolean;
	  }
	| {
			/** F9: arquivo gerado pelo agente (PDF, Word, Excel, texto, código). */
			id: string;
			kind: "file";
			artifactId: string;
			filename: string;
			mime: string;
			size: number;
			version?: number;
			/** Anexo enviado pelo usuário (sem isto, arquivo gerado pelo agente). */
			origin?: "user";
	  }
	| {
			/** F12/B5: o agente pediu login e o run está pausado até o "Terminei". */
			id: string;
			kind: "login";
			loginId: string;
			site: string;
			url: string;
			status?: "pending" | "done";
			/** F12/D3: captcha a resolver no viewer (padrão: login). */
			reason?: "login" | "captcha";
			/** Login de app pelo Composio, sem credenciais no card. */
			composioToolkit?: string;
			/** Card "conectar app" com ícone, nome e descrição. */
			connector?: LoginConnector;
			/** Login do Cofre que casa com o site ("Entrar" / "Eu faço"). */
			vault?: LoginVaultOffer;
			/** Cofre já usado e o site pediu mais um passo. */
			vaultTried?: string;
			/** Campo de código (e-mail/SMS) no card. */
			codeField?: boolean;
			runId?: string;
	  }
	| {
			id: string;
			kind: "bot-profile-confirm";
			proposal: BotProfileProposal;
			status?: "pending" | "approved" | "rejected";
			isApplying?: boolean;
			error?: string | null;
	  }
	| {
			id: string;
			kind: "skill";
			action: "created" | "updated" | "deleted" | "shown" | "listed" | "cleaned";
			title?: string;
			capabilityKey?: string;
			versionNumber?: number;
			agentName?: string;
			detail?: string;
			items?: SkillListItemData[];
			draftCount?: number;
	  }
	| {
			id: string;
			kind: "subagents";
			groupId: string;
			tasks: SubagentTaskView[];
	  }
	| { id: string; kind: "devsession"; sessionId: string; /** Hora em que a sessão começou (âncora do turno); não é exibida. */ anchorAt?: string }
	| { id: string; kind: "context-summary"; before: number; after: number; mergedIds?: string[] }
	| {
			id: string;
			kind: "tool-budget";
			tool: string;
			connectorName?: string;
			from: number;
			to: number;
	  }
	| { id: string; kind: "jev-status"; text: string }
	| { id: string; kind: "provider-fallback"; text: string; from: string; to: string }
	/** O bot gravou na memória durante o run ("Memória atualizada · ver"); só do cliente, não é persistido. */
	| { id: string; kind: "memory-updated" }
	/** Execução do run_code (código + saída truncada); `callId` liga o cartão ao vivo ao gravado. */
	| { id: string; kind: "code-run"; callId?: string; code: string; status: "running" | "ok" | "error"; durationMs?: number; output?: string }
	/** Placeholder ao vivo enquanto `generate_image` roda (só do cliente, nunca persistido). */
	| { id: string; kind: "image-gen"; callId: string; count: 1 | 2; aspectRatio: string; startedAt: number; status: "running" | "error"; error?: string }
	/** Checklist de passos do run (`update_task_list`); um cartão por run, atualizado no lugar. */
	| { id: string; kind: "task-list"; runId: string; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
	/** `/compact`: a conversa levada foi resumida (números antes/depois e o texto do resumo); persistido na thread. */
	| { id: string; kind: "compaction"; before: number; after: number; summary: string; focus?: string }
	/** Gráfico nativo (spec validado) gerado pelo run_code em *.chart.json. */
	| { id: string; kind: "chart"; chartId: string; spec: ChartSpec; filename?: string }
	| {
			id: string;
			kind: "routine";
			action: "created" | "listed" | "updated";
			title?: string;
			routineId?: string;
			triggerType?: "cron" | "event" | "once" | "interval";
			detail?: string;
			hookUrl?: string;
			hookSecret?: string;
			items?: RoutineListItemData[];
	  }
	| {
			id: string;
			kind: "questionnaire";
			questionnaireId: string;
			title: string;
			description?: string;
			items: QuestionnaireItemData[];
			status?: QuestionnaireStatus;
			answers?: QuestionnaireAnswersData;
	  }
	| {
			/** Gate humano do propose_skill/delete_skill; o estado mora em `proposal.status`. */
			id: string;
			kind: "skill-proposal";
			proposal: SkillProposalData;
			isApplying?: boolean;
			error?: string | null;
	  }
	| {
			/** Gate humano do propose_bot (novo agente); o estado mora em `proposal.status`. */
			id: string;
			kind: "bot-proposal";
			proposal: BotProposalData;
			isApplying?: boolean;
			error?: string | null;
	  }
	| {
			/** Rotina que o bot propôs sozinho (modo proativo). `id` é o da mensagem persistida: a API resolve por ele. */
			id: string;
			kind: "routine-proposal";
			proposalId: string;
			mode: RoutineProposalMode;
			status: RoutineProposalStatus;
			spec: RoutineProposalSpec;
			routineId?: string;
			isApplying?: boolean;
			error?: string | null;
	  };

export const messages: Message[] = [
	{
		id: "m1",
		kind: "assistant",
		text: "Vamos lá. A ideia é organizar o texto inteiro para caber em cada lauda sem quebrar a estrutura. Deixa eu rodar a etapa 4 para limpar o que ficou no caminho e alinhar os autores.",
	},
	{
		id: "m2",
		kind: "assistant",
		text: "Com o material pronto, eu ajusto as citações e o tom de cada seção para ficar coeso com a matéria. Nada de cortar conteúdo: só responder de forma mais direta ao que a banca pede.",
	},
	{ id: "m3", kind: "user", text: "pode iniciar" },
	{
		id: "m4",
		kind: "assistant",
		text: "Inserindo a etapa 4 no Word agora. A ideia é deixar o documento pronto para revisão sem perder o encadeamento dos parágrafos.",
	},
	{
		id: "m5",
		kind: "attachment",
		name: "PVI_Alisson_Camargo_Santos_ABL.docx",
		meta: "64 KB",
	},
	{
		id: "m6",
		kind: "assistant",
		text: "Atualizei: etapa 4 no lugar. Dá uma olhada no Word. Se passar de 4 laudas de moka, a gente enxuga.",
	},
	{ id: "m7", kind: "user", text: "Isso em ética" },
	{
		id: "m8",
		kind: "assistant",
		text: "Aí muda o peso: Cortella não é “de fora”, é da matéria. Então ele entra como complemento livre da Ética, e não como anexo solto.",
	},
	{
		id: "m9",
		kind: "tool",
		label: "Criar rotina",
		text: "Revisar citações toda segunda",
	},
	{
		id: "m10",
		kind: "user",
		text: "Ok, então no PVI da Elisabeth a Cortella entra como complemento livre na Ética, e a base da disciplina fica Kant, Aristóteles e a OVA da Ana.",
	},
	{
		id: "m11",
		kind: "assistant",
		text: "O Word todo fica com essa cara. Se a banca cobrar 20% e autores da área, é fácil ajustar contratando e citar Cortella e Chico muito fixo.",
	},
];
