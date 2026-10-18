"use client";

import { useState } from "react";
import { UserRoundPlusIcon } from "lucide-react";
import { BOT_PROPOSAL_DESCRIPTION_MAX, BOT_PROPOSAL_NAME_MAX, type BotProposalData } from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { Textarea } from "@workspace/ui/components/textarea";
import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";

export type BotProposalEdits = { name?: string; description?: string };

export type BotProposalCardProps = {
	/** O estado (pendente/aprovada/recusada) vem em `proposal.status`. */
	proposal: BotProposalData;
	/** true enquanto a decisão é aplicada: trava os botões. */
	isApplying?: boolean;
	error?: string | null;
	/** Só para teste/estado inicial: campos de edição já abertos. */
	defaultEditing?: boolean;
	/** Criar agente; `edits` só vem quando o usuário mudou nome ou papel. */
	onApprove?: (edits?: BotProposalEdits) => void;
	onReject?: () => void;
};

function modelLabel(model: string | null): string {
	if (!model) return "Modelo padrão";
	const last = model.split("/").pop() ?? model;
	return last;
}

/**
 * Novo agente que o bot propôs: avatar, nome, papel, modelo e skills para conferir.
 * "Criar agente" cria de fato; "Editar" abre nome e papel ali mesmo; "Agora não" dispensa.
 * Decidido, só o selo e uma linha ficam (os detalhes recolhem).
 */
export function BotProposalCard({ proposal, isApplying = false, error, defaultEditing = false, onApprove, onReject }: BotProposalCardProps) {
	const [editing, setEditing] = useState(defaultEditing);
	const [name, setName] = useState(proposal.name);
	const [description, setDescription] = useState(proposal.description);
	const resolved = proposal.status !== "pending";
	const shownName = resolved ? proposal.name : name.trim() || proposal.name;
	const shownDescription = resolved ? proposal.description : description.trim() || proposal.description;
	const canSubmit = name.trim().length > 0 && description.trim().length > 0;

	const approve = () => {
		const edits: BotProposalEdits = {};
		if (name.trim() && name.trim() !== proposal.name) edits.name = name.trim();
		if (description.trim() && description.trim() !== proposal.description) edits.description = description.trim();
		onApprove?.(Object.keys(edits).length > 0 ? edits : undefined);
	};

	const title =
		proposal.status === "approved"
			? `Agente criado: “${proposal.name}”`
			: proposal.status === "rejected"
				? `Proposta dispensada: “${proposal.name}”`
				: `Criar o agente “${shownName}”?`;
	const badge =
		proposal.status === "approved"
			? ({ tone: "success", label: "Criado" } as const)
			: proposal.status === "rejected"
				? ({ tone: "muted", label: "Agora não" } as const)
				: ({ tone: "pending", label: "Novo agente" } as const);
	const note =
		proposal.status === "approved"
			? proposal.firstTask
				? "Primeira tarefa enviada."
				: "Já está na sua lista de conversas."
			: undefined;

	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={isApplying || !canSubmit} onClick={approve} size="sm" type="button">
						{isApplying ? "Criando…" : "Criar agente"}
					</Button>
					<Button disabled={isApplying} onClick={() => setEditing((value) => !value)} size="sm" type="button" variant="secondary">
						{editing ? "Pronto" : "Editar"}
					</Button>
				</>
			}
			badge={badge}
			data-kind="bot-proposal"
			detailsLabel="Ver o agente"
			error={error}
			leading={<UserRoundPlusIcon aria-hidden />}
			note={note}
			resolved={resolved}
			title={title}
			trailing={
				<Button disabled={isApplying} onClick={onReject} size="sm" type="button" variant="ghost">
					Agora não
				</Button>
			}
		>
			<div className="flex min-w-0 flex-col gap-3 rounded-xl bg-background/70 p-3 ring-1 ring-foreground/5" data-slot="bot-proposal">
				<div className="flex min-w-0 items-center gap-3">
					<AgentAvatar bodyColor={proposal.color} id={proposal.proposalId} shape={proposal.shape} size={48} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate text-base font-medium" data-slot="bot-proposal-name">
							{shownName}
						</span>
						<span className="text-xs text-muted-foreground" data-slot="bot-proposal-model">
							{modelLabel(proposal.model)}
						</span>
					</div>
				</div>
				{editing && !resolved ? (
					<div className="flex min-w-0 flex-col gap-2" data-slot="bot-proposal-edit">
						<Input
							aria-label="Nome do agente"
							disabled={isApplying}
							maxLength={BOT_PROPOSAL_NAME_MAX}
							onChange={(event) => setName(event.target.value)}
							value={name}
						/>
						<Textarea
							aria-label="O que o agente faz"
							className="min-h-24"
							disabled={isApplying}
							maxLength={BOT_PROPOSAL_DESCRIPTION_MAX}
							onChange={(event) => setDescription(event.target.value)}
							value={description}
						/>
					</div>
				) : (
					<p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-slot="bot-proposal-role">
						{shownDescription}
					</p>
				)}
				{proposal.skills.length > 0 ? (
					<div className="flex min-w-0 flex-wrap items-center gap-1.5" data-slot="bot-proposal-skills">
						<span className="text-xs text-muted-foreground">Skills</span>
						{proposal.skills.map((skill) => (
							<Badge key={skill} variant="secondary">
								{skill}
							</Badge>
						))}
					</div>
				) : null}
				{proposal.firstTask ? (
					<p className="m-0 line-clamp-3 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-slot="bot-proposal-task">
						<span className="font-medium text-foreground">Primeira tarefa: </span>
						{proposal.firstTask}
					</p>
				) : null}
			</div>
		</RequestCard>
	);
}
