import type { DraftRevisionReason } from "./draft-revision.js";
import type { ChartSpec } from "./chart-spec.js";
import type { PageSpec } from "./page-spec.js";
import type { RunTelemetryMeta } from "./run-telemetry.js";
import type { ComputerMetrics } from "./computer-state.js";
import type { DevApprovalCardInfo } from "./dev-command-approval.js";
import type { SecretsRequestInfo } from "./dev-env-auto.js";
import type { EmailKeyRequestInfo } from "./email.js";
import type { PlanInfo } from "./plan.js";
import type { GithubIdentityCardInfo } from "./github-identity.js";
import type { ChatMessage } from "./chat.js";
import type { QuestionnaireCardItem, PersistedImagesCard } from "./skill-card.js";
import type { SkillProposalEvent } from "./skill-proposal.js";
import type { BotProposalEvent } from "./bot-proposal.js";
import type { LoginConnector } from "./login-connector.js";
import type { LoginVaultOffer } from "./login-wall.js";
import type { AgentPointerEvent } from "./agent-pointer.js";
import type { ContextCompactedEvent, ContextUsageEvent, DevSessionEvent, DevTimingEvent } from "./dev-session.js";

/**
 * Uso acumulado de um run (pai + filhos). `costUsd` é o custo REAL cobrado
 * pelo OpenRouter (usage.cost); `cachedTokens` os tokens lidos do cache.
 * Ambos opcionais: ausentes quando o provider não informa.
 */
export type RunUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens?: number;
	/** Tokens gravados no cache de prompt (~1,25x). */
	cacheWriteTokens?: number;
	costUsd?: number;
	/**
	 * Chamadas (modelo, visão, imagem) cujo custo o provider não informou.
	 * Quando > 0, `costUsd` é PARCIAL (soma só das conhecidas). Desconhecido não é zero.
	 */
	costUnknownCalls?: number;
	/** Chamadas que consomem a cota do plano, sem custo USD desconhecido. */
	planCalls?: number;
	/** F12/D4: métricas do uso do computador neste run (sem mudar o schema). */
	computer?: ComputerMetrics;
	/** F0: metadados de telemetria do run (setup, pós-conclusão, Jev). Sem conteúdo. */
	telemetry?: RunTelemetryMeta;
};

/** Item de skill para listagem na UI (ativas + rascunhos). */
export type SkillListItemData = {
	capabilityKey: string;
	title: string;
	versionNumber: number;
	description?: string;
	status: "active" | "draft";
};
/** Pedido para o loop de computer-use (agente dirigindo o sandbox). */
export type ComputerUseRequest = {
	messages: ChatMessage[];
	model?: string;
	conversationId?: string;
	/** Bot associado ao turno (define a memória por bot). */
	botId?: string;
	/** Quando ausente, a API pode criar/gerenciar a sessão automaticamente. */
	sandboxSessionId?: string;
	maxSteps?: number;
};

/** Eventos emitidos via SSE pelo endpoint de computer-use. */
export type ComputerUseEvent =
	| { type: "provider_fallback"; from: string; to: string; reason: string; message: string }
	| { type: "images"; origin: "assistant"; items: PersistedImagesCard["items"]; caption?: string }
	| { type: "run"; runId: string; status: string }
	| { type: "assistant_delta"; id: string; delta: string }
	/**
	 * Fala já transmitida que não é a resposta final (o run segue e refaz). `id` = o mesmo do
	 * `assistant_delta` do passo; `reason` diz por quê (ver `draft-revision.ts`). Só `duplicate`
	 * some da tela; o resto fica visível, recolhido como rascunho revisado.
	 */
	| { type: "assistant_discard"; id?: string; reason?: DraftRevisionReason }
	| AgentPointerEvent
	| DevSessionEvent
	| ContextCompactedEvent
	| ContextUsageEvent
	| DevTimingEvent
	| { type: "session"; sessionId: string; viewerUrl: string }
	/**
	 * A ferramenta `name` acabou de ser escolhida e o modelo ainda gera os argumentos (antes do `tool_call`).
	 * Só a UI ao vivo usa (o avatar mostra a ação cedo); nunca leva argumentos, não vira mensagem do chat
	 * e some do log do run na retenção. Cliente antigo ignora o tipo desconhecido.
	 */
	| { type: "tool_intent"; name: string }
	| { type: "tool_call"; id: string; name: string; args: string; step?: number; maxSteps?: number }
	| {
			type: "tool_result";
			id: string;
			name: string;
			ok: boolean;
			summary: string;
			/** Estado mínimo da revisão sem probabilidades, pedido ou argumentos. */
			jev?: { mode: "shadow" | "gate"; result: "allow" | "ask" | "unavailable" };
	  }
	| {
			type: "tool_budget_extended";
			tool: string;
			connectorName?: string;
			from: number;
			to: number;
	  }
	| {
			/** `delegate_task` abriu um subagente (F5). */
			type: "subagent_started";
			/** Uma chamada de `delegate_task` (agrupa as 1-3 tarefas na UI). */
			groupId: string;
			taskIndex: number;
			goal: string;
			/** Título curto (1-3 palavras) dado pelo agente. */
			title?: string;
			childRunId: string;
			/** Modelo do subagente. */
			model?: string;
	  }
	| {
			/** Tool do filho terminou (compacto; a UI pode ignorar). */
			type: "subagent_tool";
			groupId: string;
			taskIndex: number;
			childRunId: string;
			name: string;
			ok: boolean;
	  }
	| {
			type: "subagent_done";
			groupId: string;
			taskIndex: number;
			childRunId: string;
			status: "ok" | "partial" | "failed";
			summary: string;
			toolsUsed: string[];
			title?: string;
			model?: string;
	  }
	| { type: "done"; message: ChatMessage; model: string; usage?: RunUsage; stopReason?: string }
	| { type: "paused"; reason?: string }
	| { type: "cancelled"; reason?: string; stopReason?: string }
	| { type: "input_consumed"; inputId: string; mode: string; content: string }
	| { type: "input_received"; inputId: string; mode: string; content: string }
	| { type: "status"; status: string; detail?: string; stopReason?: string }
	| { type: "error"; error: string; stopReason?: string }
	| {
			type: "skill";
			action: "created" | "updated" | "deleted" | "shown" | "listed" | "cleaned";
			skillId?: string;
			capabilityKey?: string;
			title?: string;
			versionNumber?: number;
			detail?: string;
			items?: SkillListItemData[];
			draftCount?: number;
			/** Gravada sozinha pelo agente: o card mostra "Aprendi" e oferece desfazer. */
			learned?: boolean;
	  }
	| SkillProposalEvent
	| BotProposalEvent
	| {
			type: "routine";
			action: "created" | "listed" | "updated";
			routineId?: string;
			title?: string;
			triggerType?: "cron" | "event" | "once" | "interval";
			detail?: string;
			hookUrl?: string;
			hookSecret?: string;
			items?: Array<{
				id: string;
				name: string;
				triggerType: "cron" | "event" | "once" | "interval";
				enabled: boolean;
				schedule?: string | null;
				hookKey?: string;
			}>;
	  }
	| {
		/** Checklist de passos do run (`update_task_list`): a lista inteira substitui a anterior; vazia = removida. */
		type: "task_list";
		items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
		runId?: string;
	  }
	| {
		/** Gráfico nativo (spec validado) escrito pelo `run_code` em /work/out/*.chart.json. */
		type: "chart";
		chartId: string;
		spec: ChartSpec;
		filename?: string;
		runId?: string;
	  }
	| {
		/** Página viva (relatório/painel) criada ou atualizada no lugar: o mesmo `pageId` troca de revisão, não vira outra mensagem. */
		type: "page";
		action: "created" | "updated";
		pageId: string;
		revision: number;
		title: string;
		spec: PageSpec;
		sourceCount: number;
		runId?: string;
	  }
	| {
		/** F9: arquivo gerado (PDF, Word, Excel, texto…) guardado como artefato do dono. */
		type: "file";
		artifactId: string;
		filename: string;
		mime: string;
		size: number;
		format: "text" | "docx" | "pdf" | "xlsx" | "pptx";
		version: number;
		runId?: string;
	  }
	| {
		/** F12/B5: pedido de login ao usuário (o run pausa até o "Terminei"). */
		type: "login";
		loginId: string;
		site: string;
		url: string;
		runId?: string;
		status?: "pending" | "done";
		/** F12/D3: `captcha` = resolver o desafio no viewer (padrão: login). */
		reason?: "login" | "captcha";
		/** Login de app pelo Composio, sem credenciais no card. */
		composioToolkit?: string;
		/** Card "conectar app" (ícone, nome, descrição); o clique usa o fluxo normal do conector. */
		connector?: LoginConnector;
		/** Há login do Cofre para este site: o card oferece "Entrar" / "Eu faço". */
		vault?: LoginVaultOffer;
		/** O login do Cofre já foi usado e o site pediu mais um passo: o card humano explica o que falta. */
		vaultTried?: string;
		/** O card pede o código recebido por e-mail/SMS num campo (o valor vai direto ao runtime, não ao modelo). */
		codeField?: boolean;
	  }
	| {
		type: "confirm";
		confirmId: string;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		/** Terceira ação ("Não perguntar mais para isto"): cria exceção `never_ask` e executa. */
		alwaysLabel?: string;
		/** Chave estável da chamada de conector confirmada (tool + args). */
		callKey?: string;
		/** Aprovação de comando/escrita de sessão de código (mostra o comando, cwd e ações próprias). */
		devApproval?: DevApprovalCardInfo;
		/** Pedido de segredos do projeto (cartão com textarea; só nomes, nunca valores). */
		secretsRequest?: SecretsRequestInfo;
		/** Pedido da chave do e-mail (cartão com campo de senha; o valor nunca passa pelo modelo). */
		emailKeyRequest?: EmailKeyRequestInfo;
		/** Plano proposto (`propose_plan`): passos, o que falta saber e riscos; o cartão tem "Aprovar plano", "Ajustar" e "Cancelar". */
		plan?: PlanInfo;
		/** Escrita no GitHub bloqueada (repositório fora do app): instalar o app ou usar a conta desta vez. */
		githubIdentity?: GithubIdentityCardInfo;
		/** Card já decidido (ex.: resumo de autonomia): sem botões e não para o run. */
		status?: "pending" | "approved" | "rejected";
  }
	| {
			type: "questionnaire";
			questionnaireId: string;
			title: string;
			description?: string;
			items: QuestionnaireCardItem[];
			status?: "pending" | "submitted" | "dismissed";
			/** `"onboarding"` só no fluxo de config do bot; ausente/`"task"` = pedido comum. */
			purpose?: "task" | "onboarding";
			/** Pedido original do usuário que gerou o questionário (`purpose: "task"`). */
			originalRequest?: string;
	  }
	| {
			type: "bot-profile";
			proposalId: string;
			botId: string;
			before: {
				name: string;
				snippet: string;
				description: string | null;
				openRouterModel: string | null;
			};
			after: {
				name?: string;
				snippet?: string;
				description?: string | null;
				openRouterModel?: string | null;
			};
			fields: Array<"name" | "snippet" | "description" | "openRouterModel">;
			status?: "pending" | "approved" | "rejected";
	  };
