"use client";

import {
	CheckIcon,
	CopyIcon,
	EyeOffIcon,
	FolderInputIcon,
	FolderOutputIcon,
	FolderPlusIcon,
	MailIcon,
	MailOpenIcon,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	StarIcon,
	Trash2Icon,
} from "lucide-react";

import type { Section } from "@workspace/shared";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@workspace/ui/components/context-menu";

import type { Agent } from "../data";
import { copyText } from "../chat-thread/message-reactions";

export type AgentMenuActions = {
	onEdit: (id: string) => void;
	onPin: (id: string) => void;
	onUnpin: (id: string) => void;
	onMarkUnread: (id: string, unread: boolean) => void;
	onHide: (id: string) => void;
	onDelete: (id: string) => void;
	onMoveToSection: (id: string, sectionId: string | null) => void;
	onCreateSectionFor: (id: string) => void;
	/** Marca o bot como principal (um por conta). */
	onSetPrimary: (id: string) => void;
	/** Abre o seletor "Escolha um Bot principal". */
	onReplacePrimary: () => void;
	/** Há 2+ bots simples: só então o menu oferece o Bot principal. */
	canPickPrimary?: boolean;
};

export function AgentContextMenu({
	agent,
	actions,
	sections = [],
	children,
}: {
	agent: Agent;
	actions: AgentMenuActions;
	sections?: Section[];
	children: React.ReactNode;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger render={<div className="contents" />}>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent align="start" side="right" sideOffset={8}>
				<ContextMenuItem onClick={() => actions.onEdit(agent.id)}>
					<PencilIcon />
					{agent.members?.length ? "Informações do grupo" : "Editar"}
				</ContextMenuItem>
					{actions.canPickPrimary && !agent.members?.length ? (
						agent.isPrimary ? (
							<ContextMenuItem onClick={() => actions.onReplacePrimary()}>
								<StarIcon />
								Trocar Bot principal
							</ContextMenuItem>
						) : (
							<ContextMenuItem onClick={() => actions.onSetPrimary(agent.id)}>
								<StarIcon />
								Definir como Bot principal
							</ContextMenuItem>
						)
					) : null}
				{agent.pinned ? (
					<ContextMenuItem onClick={() => actions.onUnpin(agent.id)}>
						<PinOffIcon />
						Desafixar
					</ContextMenuItem>
				) : (
					<ContextMenuItem onClick={() => actions.onPin(agent.id)}>
						<PinIcon />
						Fixar
					</ContextMenuItem>
				)}
				{agent.notifications ? (
					<ContextMenuItem
						onClick={() => actions.onMarkUnread(agent.id, false)}
					>
						<MailOpenIcon />
						Marcar como lido
					</ContextMenuItem>
				) : (
					<ContextMenuItem onClick={() => actions.onMarkUnread(agent.id, true)}>
						<MailIcon />
						Marcar como não lido
					</ContextMenuItem>
				)}
				<ContextMenuItem
					onClick={() => {
						void copyText(agent.conversationId ?? agent.id);
					}}
				>
					<CopyIcon />
					Copiar ID da conversa
				</ContextMenuItem>
				{sections.length > 0 ? (
					<ContextMenuSub>
						<ContextMenuSubTrigger className="gap-2.5">
							<FolderInputIcon />
							Mover para sessão
						</ContextMenuSubTrigger>
						<ContextMenuSubContent className="w-52 min-w-0">
							<ContextMenuItem
								onClick={() => actions.onCreateSectionFor(agent.id)}
							>
								<FolderPlusIcon />
								Nova sessão…
							</ContextMenuItem>
							<ContextMenuSeparator />
								{sections.map((section) => (
									<ContextMenuItem
										key={section.id}
										onClick={() =>
											actions.onMoveToSection(agent.id, section.id)
										}
									>
										<span className="min-w-0 flex-1 truncate">
											{section.name}
										</span>
										{agent.sectionId === section.id ? (
											<CheckIcon className="ml-auto" />
										) : null}
									</ContextMenuItem>
								))}
							{agent.sectionId ? (
								<>
									<ContextMenuSeparator />
									<ContextMenuItem
										onClick={() => actions.onMoveToSection(agent.id, null)}
									>
										<FolderOutputIcon />
										Remover da sessão
									</ContextMenuItem>
								</>
							) : null}
						</ContextMenuSubContent>
					</ContextMenuSub>
				) : (
					<ContextMenuItem
						onClick={() => actions.onCreateSectionFor(agent.id)}
					>
						<FolderInputIcon />
						Mover para sessão
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => actions.onHide(agent.id)}>
					<EyeOffIcon />
					Ocultar da barra lateral
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => actions.onDelete(agent.id)}
					variant="destructive"
				>
					<Trash2Icon />
					{agent.members?.length ? "Excluir grupo" : "Excluir"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
