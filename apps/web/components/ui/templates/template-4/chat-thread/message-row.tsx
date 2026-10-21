"use client";

import {
	DownloadIcon,
	FileTextIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	SparklesIcon,
} from "lucide-react";

import {
	Bubble,
	BubbleContent,
} from "@workspace/ui/components/bubble";
import { Button } from "@workspace/ui/components/button";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { cn } from "@workspace/ui/lib/utils";
import { CopyButton, ReactionBadges, ReactionTrigger, useMessageReactionControls } from "./message-reactions";

import type { Message } from "../data";
import { SkillActivityCard, SkillProposalCard, SkillsList } from "@/components/ai-elements/skills";
import { BotProposalCard, type BotProposalEdits } from "@/components/ai-elements/bots";
import {
	RoutineActivityCard,
	RoutineProposalCard,
	RoutinesList,
	type OpenRoutinePayload,
} from "@/components/ai-elements/routines";
import { BotProfileConfirmCard, ConfirmCard, GithubIdentityCard } from "@/components/ai-elements/confirm";
import { SecretsRequestCard } from "@/components/ai-elements/dev-session/secrets-request-card";
import { EmailKeyRequestCard } from "@/components/ai-elements/email/email-key-request-card";
import { VaultRequestCard } from "@/components/ai-elements/dev-session/vault-request-card";
import { DevApprovalCard } from "@/components/ai-elements/dev-session/dev-approval-card";
import { FileAttachment } from "@/components/ai-elements/files";
import { ConnectorLoginCard, legacyComposioConnector } from "@/components/ai-elements/login/connector-login-card";
import { LoginCard } from "@/components/ai-elements/login";
import { openVaultNewLogin } from "@/components/settings/settings-url";
import { DevSessionCard } from "@/components/ai-elements/dev-session/dev-session-card";
import { SubagentsBlock } from "@/components/ai-elements/subagents";
import { ToolBudgetMarker } from "@/components/ai-elements/tool-budget";
import { AssistantMessage } from "./assistant-message";
import { EmailReceivedCard } from "./email-received-card";
import { LazyChart } from "@/components/ai-elements/chart/lazy-chart";
import { CodeRunCard } from "./code-run-card";
import { TaskListCard } from "./task-list-card";
import { PlanCard, type PlanCardStatus } from "@workspace/ui/components/plan-card";
import { CompactionCard } from "./compaction-card";
import { ImagePendingCard } from "@/components/ai-elements/images/image-pending-card";
import { MemoryUpdatedMarker } from "./memory-updated-marker";
import { ImageGallery } from "@/components/ai-elements/images/image-gallery";
import {
	QuestionnaireCard,
	type QuestionnaireAnswersMap,
	type QuestionnaireCardMessage,
} from "./questionnaire-card";
import { bubbleRadius, type GroupPosition } from "./bubble-radius";
import { renderMentions, type MentionMember } from "./mention-text";

export function MessageRow({
	live = false,
	message,
	groupPosition = "single",
	onConfirm,
	onConfirmAlways,
	onConfirmReject,
	onCancel,
	onAdjustPlan,
	onLoginOpenViewer,
	onLoginDone,
	onLoginUseVault,
	onLoginCode,
	onBotProfileConfirm,
	onBotProfileDismiss,
	onBotProfileEdit,
	onOpenRoutine,
	onOpenMemory,
	onQuestionnaireSubmit,
	onQuestionnaireDismiss,
	onSkillProposalApprove,
	onSkillProposalReject,
	onSkillProposalEdit,
	skillBots,
	mentionMembers,
	knownSkills,
	onRoutineProposalAccept,
	onRoutineProposalDecline,
	onBotProposalApprove,
	onBotProposalReject,
}: {
	/** Grupo: membros para desenhar as menções (@Nome) como chips. */
	mentionMembers?: readonly MentionMember[];
	/** Chat 1:1: `/skill` conhecidas, para desenhar o token como chip no balão do usuário. */
	knownSkills?: ReadonlySet<string>;
	live?: boolean;
	message: Message;
	groupPosition?: GroupPosition;
	onConfirm?: (message: Extract<Message, { kind: "confirm" }>) => void;
	/** "Não perguntar mais para isto": confirma e cria a exceção de autonomia. */
	onConfirmAlways?: (message: Extract<Message, { kind: "confirm" }>) => void;
	onCancel?: (message: Extract<Message, { kind: "confirm" }>) => void;
	/** "Ajustar" no cartão do plano: abre o composer com o rascunho do ajuste. */
	onAdjustPlan?: (message: Extract<Message, { kind: "confirm" }>) => void;
	/** "Recusar com comentário" (aprovação de comando): o agente recebe o comentário. */
	onConfirmReject?: (message: Extract<Message, { kind: "confirm" }>, feedback: string) => void;
	/** Card de login (F12/B5): abre o viewer da VM; "Terminei" retoma o run. */
	onLoginOpenViewer?: (message: Extract<Message, { kind: "login" }>) => void;
	onLoginDone?: (message: Extract<Message, { kind: "login" }>) => void;
	onLoginUseVault?: (message: Extract<Message, { kind: "login" }>) => void;
	onLoginCode?: (message: Extract<Message, { kind: "login" }>, code: string) => void;
	onBotProfileConfirm?: (
		message: Extract<Message, { kind: "bot-profile-confirm" }>,
	) => void;
	onBotProfileDismiss?: (
		message: Extract<Message, { kind: "bot-profile-confirm" }>,
	) => void;
	onBotProfileEdit?: (
		message: Extract<Message, { kind: "bot-profile-confirm" }>,
	) => void;
	onOpenRoutine?: (payload: OpenRoutinePayload) => void;
	/** "Memória atualizada · ver": abre a aba Memória do painel. */
	onOpenMemory?: () => void;
	onQuestionnaireSubmit?: (
		message: QuestionnaireCardMessage,
		answers: QuestionnaireAnswersMap,
	) => void;
	onQuestionnaireDismiss?: (message: QuestionnaireCardMessage) => void;
	/** Gate humano do propose_skill/delete_skill (aprovar, recusar, editar antes). */
	onSkillProposalApprove?: (message: Extract<Message, { kind: "skill-proposal" }>) => void;
	onSkillProposalReject?: (message: Extract<Message, { kind: "skill-proposal" }>) => void;
	onSkillProposalEdit?: (message: Extract<Message, { kind: "skill-proposal" }>) => void;
	skillBots?: readonly { id: string; name: string }[];
	/** Rotina proposta pelo bot (modo proativo): Criar/Manter e Agora não/Desfazer. */
	onRoutineProposalAccept?: (message: Extract<Message, { kind: "routine-proposal" }>) => void;
	onRoutineProposalDecline?: (message: Extract<Message, { kind: "routine-proposal" }>) => void;
	/** Novo agente proposto pelo bot (propose_bot): criar (com nome/papel revisados) ou dispensar. */
	onBotProposalApprove?: (message: Extract<Message, { kind: "bot-proposal" }>, edits?: BotProposalEdits) => void;
	onBotProposalReject?: (message: Extract<Message, { kind: "bot-proposal" }>) => void;
}) {
	switch (message.kind) {
		case "images":
			return <ImageGallery items={message.items} source={message.source} />;
		case "assistant":
			return (
				<AssistantMessage
					groupPosition={groupPosition}
					live={live}
					messageId={message.id}
					runId={message.runId}
					text={message.text}
				/>
			);
		case "user":
			if (message.email) return <EmailReceivedCard from={message.email.from} subject={message.email.subject} text={message.text} />;
			if (!message.text.trim()) return null;
			return (
				<UserMessageBubble groupPosition={groupPosition} knownSkills={knownSkills} mentionMembers={mentionMembers} messageId={message.id} text={message.text} />
			);
		case "attachment":
			return (
				<div className="flex w-full max-w-sm items-center gap-3 rounded-2xl border bg-card p-3">
					<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
						<FileTextIcon className="size-4" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium text-sm">
							{message.name}
						</span>
						<span className="block text-muted-foreground text-xs">
							{message.meta}
						</span>
					</span>
					<Button aria-label="Baixar" size="icon-sm" variant="ghost">
						<DownloadIcon />
					</Button>
				</div>
			);
		case "tool":
			return (
				<div className="flex items-center gap-2 self-start rounded-2xl border bg-card px-3 py-2 text-xs">
					<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
						<SparklesIcon className="size-3" />
					</span>
					<span className="text-muted-foreground">{message.label}</span>
					<span className="font-medium text-foreground">{message.text}</span>
				</div>
			);
		case "skill":
			if ((message.action as string) === "creating") return null;
			if (message.action === "listed") {
				return (
					<SkillsList items={message.items ?? []} draftCount={message.draftCount} />
				);
			}
			return (
				<SkillActivityCard
					action={message.action}
					agentName={message.agentName}
					capabilityKey={message.capabilityKey}
					title={message.title}
					versionNumber={message.versionNumber}
					detail={message.detail}
				/>
			);
		case "devsession":
			return <DevSessionCard sessionId={message.sessionId} />;
		case "context-summary":
			return (
				<Marker className="my-1 text-xs" data-testid="context-summary" variant="separator">
					<MarkerContent>{message.mergedIds && message.mergedIds.length > 1 ? `Contexto resumido ×${message.mergedIds.length}` : "Contexto resumido"}</MarkerContent>
				</Marker>
			);
		case "subagents":
			return <SubagentsBlock groupId={message.groupId} tasks={message.tasks} />;
		case "tool-budget":
			return (
				<ToolBudgetMarker
					tool={message.tool}
					connectorName={message.connectorName}
					to={message.to}
				/>
			);
		case "jev-status":
			return (
				<Marker variant="separator" className="my-1">
					<MarkerIcon><ShieldCheckIcon /></MarkerIcon>
					<MarkerContent>{message.text}</MarkerContent>
				</Marker>
			);
		case "provider-fallback":
			return (
				<Marker variant="separator" className="my-1">
					<MarkerIcon><RefreshCwIcon /></MarkerIcon>
					<MarkerContent>{message.text}</MarkerContent>
				</Marker>
			);
		case "image-gen":
			return <ImagePendingCard aspectRatio={message.aspectRatio} count={message.count} error={message.error} startedAt={message.startedAt} status={message.status} />;
		case "code-run":
			return <CodeRunCard code={message.code} durationMs={message.durationMs} output={message.output} status={message.status} />;
		case "chart":
			return <LazyChart spec={message.spec} />;
		case "task-list":
			return <TaskListCard items={message.items} />;
		case "compaction":
			return <CompactionCard after={message.after} before={message.before} focus={message.focus} summary={message.summary} />;
		case "memory-updated":
			return <MemoryUpdatedMarker onOpen={onOpenMemory} />;
		case "routine":
			if (message.action === "listed") {
				return (
					<RoutinesList
						items={message.items ?? []}
						onOpen={onOpenRoutine}
					/>
				);
			}
			return (
				<RoutineActivityCard
					action={message.action}
					title={message.title}
					routineId={message.routineId}
					triggerType={message.triggerType}
					detail={message.detail}
					hookUrl={message.hookUrl}
					hookSecret={message.hookSecret}
					onOpen={onOpenRoutine}
				/>
			);
		case "confirm":
			if (message.plan) {
				const status: PlanCardStatus = message.status === "approved" ? "approved" : message.status === "failed" ? "failed" : message.status === "rejected" ? (message.planOutcome === "ajuste pedido" ? "adjusted" : "cancelled") : "pending";
				return (
					<PlanCard
						adjustLabel="Ajustar"
						approveLabel={message.confirmLabel}
						cancelLabel={message.cancelLabel}
						needs={message.plan.needs}
						onAdjust={onAdjustPlan ? () => onAdjustPlan(message) : undefined}
						onApprove={() => onConfirm?.(message)}
						onCancel={() => onCancel?.(message)}
						risks={message.plan.risks}
						status={status}
						steps={message.plan.steps}
						title={message.plan.title}
					/>
				);
			}
			if (message.emailKeyRequest) {
				return (
					<EmailKeyRequestCard
						description={message.description}
						onSaved={() => onConfirm?.(message)}
						onSkip={() => onCancel?.(message)}
						status={message.status ?? "pending"}
						title={message.title}
					/>
				);
			}
			if (message.secretsRequest?.environmentId === "vault") {
				return (
					<VaultRequestCard
						cancelLabel={message.cancelLabel}
						confirmLabel={message.confirmLabel}
						description={message.description}
						info={message.secretsRequest}
						onSaved={() => onConfirm?.(message)}
						onSkip={() => onCancel?.(message)}
						status={message.status ?? "pending"}
						title={message.title}
					/>
				);
			}
			if (message.secretsRequest) {
				return (
					<SecretsRequestCard
						cancelLabel={message.cancelLabel}
						confirmLabel={message.confirmLabel}
						description={message.description}
						info={message.secretsRequest}
						onSaved={() => onConfirm?.(message)}
						onSkip={() => onCancel?.(message)}
						status={message.status ?? "pending"}
						title={message.title}
					/>
				);
			}
			if (message.devApproval) {
				return (
					<DevApprovalCard
						confirmLabel={message.confirmLabel}
						cancelLabel={message.cancelLabel}
						info={message.devApproval}
						onAlways={onConfirmAlways ? () => onConfirmAlways(message) : undefined}
						onConfirm={() => onConfirm?.(message)}
						onReject={onConfirmReject ? (feedback) => onConfirmReject(message, feedback) : undefined}
						onSkip={() => onCancel?.(message)}
						status={message.status ?? "pending"}
						title={message.title}
					/>
				);
			}
			if (message.githubIdentity) {
				return (
					<GithubIdentityCard
						info={message.githubIdentity}
						onCancel={() => onCancel?.(message)}
						onDone={() => onConfirm?.(message)}
						status={message.status ?? "pending"}
					/>
				);
			}
			return (
				<ConfirmCard
					title={message.title}
					description={message.description}
					status={message.status ?? "pending"}
					confirmLabel={message.confirmLabel}
					cancelLabel={message.cancelLabel}
					alwaysLabel={message.alwaysLabel}
					onConfirm={() => onConfirm?.(message)}
					onCancel={() => onCancel?.(message)}
					onAlways={
						message.alwaysLabel && onConfirmAlways
							? () => onConfirmAlways(message)
							: undefined
					}
				/>
			);
		case "file":
			return (
				<FileAttachment
					artifactId={message.artifactId}
					filename={message.filename}
					mime={message.mime}
					origin={message.origin}
					size={message.size}
					version={message.version}
				/>
			);
		case "login":
			if (message.connector || message.composioToolkit) {
				return <ConnectorLoginCard connector={message.connector ?? legacyComposioConnector(message.composioToolkit!)} status={message.status} onDone={() => onLoginDone?.(message)} />;
			}
			return (
				<LoginCard
					canOpenViewer={Boolean(onLoginOpenViewer)}
					onDone={() => onLoginDone?.(message)}
					onOpenViewer={onLoginOpenViewer ? () => onLoginOpenViewer(message) : undefined}
					onSaveToVault={() => openVaultNewLogin(message.site)}
					codeField={message.codeField}
					onSubmitCode={(code) => onLoginCode?.(message, code)}
					onUseVault={() => onLoginUseVault?.(message)}
					reason={message.reason}
					vault={message.vault}
					vaultTried={message.vaultTried}
					site={message.site}
					status={message.status ?? "pending"}
				/>
			);
		case "bot-profile-confirm":
			return (
				<BotProfileConfirmCard
					proposal={message.proposal}
					status={message.status ?? "pending"}
					isApplying={message.isApplying ?? false}
					error={message.error ?? null}
					onConfirm={() => onBotProfileConfirm?.(message)}
					onDismiss={() => onBotProfileDismiss?.(message)}
					onEdit={
						onBotProfileEdit ? () => onBotProfileEdit?.(message) : undefined
					}
				/>
			);
		case "skill-proposal":
			return (
				<SkillProposalCard
					bots={skillBots}
					error={message.error ?? null}
					isApplying={message.isApplying ?? false}
					onApprove={() => onSkillProposalApprove?.(message)}
					onEditFirst={onSkillProposalEdit ? () => onSkillProposalEdit(message) : undefined}
					onReject={() => onSkillProposalReject?.(message)}
					proposal={message.proposal}
				/>
			);
		case "bot-proposal":
			return (
				<BotProposalCard
					error={message.error ?? null}
					isApplying={message.isApplying ?? false}
					onApprove={(edits) => onBotProposalApprove?.(message, edits)}
					onReject={() => onBotProposalReject?.(message)}
					proposal={message.proposal}
				/>
			);
		case "routine-proposal":
			return (
				<RoutineProposalCard
					message={message}
					onAccept={() => onRoutineProposalAccept?.(message)}
					onDecline={() => onRoutineProposalDecline?.(message)}
				/>
			);
		case "questionnaire":
			return (
				<QuestionnaireCard
					message={message}
					onSubmit={
						onQuestionnaireSubmit
							? (target, answers) => onQuestionnaireSubmit(target, answers)
							: undefined
					}
					onDismiss={
						onQuestionnaireDismiss
							? (target) => onQuestionnaireDismiss(target)
							: undefined
					}
				/>
			);
	}
}

function UserMessageBubble({
	groupPosition,
	knownSkills,
	mentionMembers,
	messageId,
	text,
}: {
	messageId?: string;
	groupPosition: GroupPosition;
	knownSkills?: ReadonlySet<string>;
	mentionMembers?: readonly MentionMember[];
	text: string;
}) {
	const controls = useMessageReactionControls(messageId);
	return (
		<div className="group/message flex items-center justify-end gap-2">
			<div className="flex shrink-0 items-center">
				{controls.canReact ? <ReactionTrigger align="end" onSelect={controls.onSelect} /> : null}
				<CopyButton text={text} />
			</div>
			<Bubble align="end" variant="muted">
				<BubbleContent
					className={cn("text-foreground", bubbleRadius("right", groupPosition))}
				>
					{mentionMembers?.length || knownSkills?.size ? renderMentions(text, mentionMembers ?? [], knownSkills) : text}
				</BubbleContent>
				<ReactionBadges reactions={controls.reactions} />
			</Bubble>
		</div>
	);
}
