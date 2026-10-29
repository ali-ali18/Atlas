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
import { useT } from "@/lib/i18n/provider";

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
	const t = useT();
	return (
		<ContextMenu>
			<ContextMenuTrigger render={<div className="contents" />}>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent align="start" side="right" sideOffset={8}>
				<ContextMenuItem onClick={() => actions.onEdit(agent.id)}>
					<PencilIcon />
					{agent.members?.length ? t("sidebar.menu.groupInfo") : t("sidebar.menu.edit")}
				</ContextMenuItem>
					{actions.canPickPrimary && !agent.members?.length ? (
						agent.isPrimary ? (
							<ContextMenuItem onClick={() => actions.onReplacePrimary()}>
								<StarIcon />
								{t("sidebar.menu.changePrimary")}
							</ContextMenuItem>
						) : (
							<ContextMenuItem onClick={() => actions.onSetPrimary(agent.id)}>
								<StarIcon />
								{t("sidebar.menu.setPrimary")}
							</ContextMenuItem>
						)
					) : null}
				{agent.pinned ? (
					<ContextMenuItem onClick={() => actions.onUnpin(agent.id)}>
						<PinOffIcon />
						{t("sidebar.menu.unpin")}
					</ContextMenuItem>
				) : (
					<ContextMenuItem onClick={() => actions.onPin(agent.id)}>
						<PinIcon />
						{t("sidebar.menu.pin")}
					</ContextMenuItem>
				)}
				{agent.notifications ? (
					<ContextMenuItem
						onClick={() => actions.onMarkUnread(agent.id, false)}
					>
						<MailOpenIcon />
						{t("sidebar.menu.markRead")}
					</ContextMenuItem>
				) : (
					<ContextMenuItem onClick={() => actions.onMarkUnread(agent.id, true)}>
						<MailIcon />
						{t("sidebar.menu.markUnread")}
					</ContextMenuItem>
				)}
				<ContextMenuItem
					onClick={() => {
						void copyText(agent.conversationId ?? agent.id);
					}}
				>
					<CopyIcon />
					{t("sidebar.menu.copyId")}
				</ContextMenuItem>
				{sections.length > 0 ? (
					<ContextMenuSub>
						<ContextMenuSubTrigger className="gap-2.5">
							<FolderInputIcon />
							{t("sidebar.menu.moveToSection")}
						</ContextMenuSubTrigger>
						<ContextMenuSubContent className="w-52 min-w-0">
							<ContextMenuItem
								onClick={() => actions.onCreateSectionFor(agent.id)}
							>
								<FolderPlusIcon />
								{t("sidebar.menu.newSection")}
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
										{t("sidebar.menu.removeFromSection")}
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
						{t("sidebar.menu.moveToSection")}
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => actions.onHide(agent.id)}>
					<EyeOffIcon />
					{t("sidebar.menu.hide")}
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => actions.onDelete(agent.id)}
					variant="destructive"
				>
					<Trash2Icon />
					{agent.members?.length ? t("sidebar.menu.deleteGroup") : t("sidebar.menu.delete")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
