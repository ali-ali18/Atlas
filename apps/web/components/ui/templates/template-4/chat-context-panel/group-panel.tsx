"use client";

import { PlusIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";

import { useT, useTranslations } from "@/lib/i18n/provider";

import { AgentAvatar } from "../agent-avatar";
import type { Agent } from "../data";
import { GroupAvatar } from "../group-avatar";

export type GroupPanelProps = {
	/** Membros atuais (na ordem do grupo). */
	members: Agent[];
	/** Bots que ainda podem entrar (não são membros nem grupos). */
	candidates: Agent[];
	onRename: (name: string) => void;
	onAddMember: (botId: string) => void | Promise<void>;
	onRemoveMember: (botId: string) => void | Promise<void>;
	/** Abre o chat do membro (como no Grok Bot: "Abrir o chat de …"). */
	onOpenMember?: (botId: string) => void;
	onDelete: () => void;
	/** Falha da última alteração (membro duplicado, mínimo de 2…). */
	error?: string | null;
};

/** Nome do grupo editável direto no cabeçalho: grava ao sair do campo ou com Enter; Esc cancela. */
function GroupNameField({ name, onRename }: { name: string; onRename: (name: string) => void }) {
	const t = useT();
	const [draft, setDraft] = useState(name);
	useEffect(() => setDraft(name), [name]);
	function commit() {
		const next = draft.trim();
		if (!next) {
			setDraft(name);
			return;
		}
		if (next !== name) onRename(next);
	}
	return (
		<Input
			aria-label={t("contextPanel.group.nameLabel")}
			className="h-9 border-transparent bg-transparent text-center font-heading font-semibold text-base shadow-none hover:border-input focus-visible:border-ring"
			maxLength={80}
			onBlur={commit}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") {
					setDraft(name);
					event.currentTarget.blur();
				}
			}}
			placeholder={t("contextPanel.group.namePlaceholder")}
			value={draft}
		/>
	);
}

/** "Adicionar membros": abre a lista de bots com busca ("Buscar", seção "Bots"). */
function AddMembers({ candidates, onAdd }: { candidates: Agent[]; onAdd: (botId: string) => void | Promise<void> }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const list = candidates.filter((candidate) => !needle || candidate.name.toLowerCase().includes(needle));
	return (
		<li className="flex flex-col gap-1">
			<button
				aria-expanded={open}
				aria-label={t("contextPanel.group.addMembers")}
				className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
					<PlusIcon className="size-4" />
				</span>
				{t("contextPanel.group.addMembers")}
			</button>
			{open ? (
				<div className="flex flex-col gap-1 rounded-2xl border border-border p-1.5" data-testid="group-add-list">
					<Input aria-label={t("common.search")} className="h-9" onChange={(event) => setQuery(event.target.value)} placeholder={t("common.search")} value={query} />
					<p className="px-2 pt-1 font-medium text-muted-foreground text-xs">{t("contextPanel.group.bots")}</p>
					{candidates.length === 0 ? (
						<p className="px-2 py-2 text-muted-foreground text-xs">{t("contextPanel.group.createMore")}</p>
					) : list.length === 0 ? (
						<p className="px-2 py-2 text-muted-foreground text-xs">{t("contextPanel.group.noneFound")}</p>
					) : (
						<ul className="flex max-h-56 flex-col overflow-y-auto">
							{list.map((candidate) => (
								<li key={candidate.id}>
									<button
										className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
										onClick={() => {
											void onAdd(candidate.id);
											setOpen(false);
											setQuery("");
										}}
										type="button"
									>
										<AgentAvatar animated={false} bodyColor={candidate.color} id={candidate.id} shape={candidate.shape} size={28} />
										<span className="min-w-0 flex-1 truncate text-sm">{candidate.name}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</li>
	);
}

/** Painel de um grupo (mesma estrutura do Grok Bot): cabeçalho, "Membros" com Remover, Adicionar membros e Excluir. */
export function GroupPanelContent({ agent, group }: { agent: Agent; group: GroupPanelProps }) {
	const { t, tn } = useTranslations();
	const canRemove = group.members.length > GROUP_MIN_MEMBERS;
	return (
		<>
			<div className="flex flex-col items-center gap-1 pt-2 text-center" data-testid="group-header">
				<GroupAvatar members={group.members} ringClassName="ring-sidebar" size={64} />
				<GroupNameField name={agent.name} onRename={group.onRename} />
				<p className="text-muted-foreground text-xs">{tn("groups.members", group.members.length)}</p>
			</div>
			<section aria-labelledby="group-members-heading" className="flex flex-col gap-2">
				<h4 className="font-medium text-muted-foreground text-xs" id="group-members-heading">
					{t("contextPanel.group.members")}
				</h4>
				<ul className="flex flex-col gap-0.5" data-testid="group-members">
					{group.members.map((member) => (
						<li className="flex items-center gap-1" data-member={member.id} key={member.id}>
							<button
								aria-label={t("contextPanel.group.openChatOf", { name: member.name })}
								className={cn(
									"flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									group.onOpenMember && "hover:bg-muted",
								)}
								disabled={!group.onOpenMember}
								onClick={() => group.onOpenMember?.(member.id)}
								type="button"
							>
								<AgentAvatar animated={false} bodyColor={member.color} id={member.id} shape={member.shape} size={36} />
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate font-medium text-sm">{member.name}</span>
									{member.isPrimary ? <StarIcon aria-label={t("groups.primary.badge")} className="size-3 shrink-0 fill-current text-muted-foreground" /> : null}
								</span>
							</button>
							<Button
								aria-label={t("contextPanel.group.removeNamed", { name: member.name })}
								disabled={!canRemove}
								onClick={() => void group.onRemoveMember(member.id)}
								size="sm"
								title={canRemove ? undefined : t("contextPanel.group.minimum", { count: GROUP_MIN_MEMBERS })}
								variant="secondary"
							>
								{t("contextPanel.group.remove")}
							</Button>
						</li>
					))}
					{group.members.length < GROUP_MAX_MEMBERS ? (
						<AddMembers candidates={group.candidates} key={agent.id} onAdd={group.onAddMember} />
					) : null}
				</ul>
				{group.error ? (
					<p className="text-destructive text-xs" role="alert">
						{group.error}
					</p>
				) : null}
			</section>
			<div className="flex flex-col gap-2 border-border border-t pt-4">
				<p className="text-muted-foreground text-xs leading-relaxed">
					{t("contextPanel.group.deleteWarning")}
				</p>
				<Button className="justify-start" onClick={group.onDelete} size="sm" variant="destructive">
					<Trash2Icon /> {t("contextPanel.group.delete")}
				</Button>
			</div>
		</>
	);
}
