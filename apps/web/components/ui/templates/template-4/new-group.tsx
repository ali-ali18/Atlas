"use client";

import { ArrowLeftIcon, ArrowUpIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import { bodyColors, type Agent, type NewGroupInput } from "./data";

/** Bots que podem entrar num grupo: os bots de verdade (grupos não entram em grupos). */
export function groupCandidates(agents: readonly Agent[]): Agent[] {
	return agents.filter((agent) => !agent.members?.length);
}

export function canCreateGroup(memberIds: readonly string[]): boolean {
	return memberIds.length >= GROUP_MIN_MEMBERS && memberIds.length <= GROUP_MAX_MEMBERS;
}

/** Nome padrão do grupo: os nomes dos membros ("Ana e Bia", "Ana, Bia e Caio"), como o Grok Bot. */
export function defaultGroupName(names: readonly string[]): string {
	const clean = names.map((name) => name.trim()).filter(Boolean);
	const joined =
		clean.length <= 1 ? (clean[0] ?? "Grupo") : `${clean.slice(0, -1).join(", ")} e ${clean[clean.length - 1]}`;
	return joined.length <= 80 ? joined : `${joined.slice(0, 79).trimEnd()}…`;
}

/** Cor do destaque do grupo: a do primeiro membro. */
export function defaultGroupColor(members: readonly Pick<Agent, "color">[]): string | undefined {
	const first = members[0]?.color;
	return first && bodyColors.some((option) => option.value === first) ? first : undefined;
}

type Row = { kind: "new-bot" } | { kind: "new-group" } | { kind: "agent"; agent: Agent };

/** Sugestões do campo "Para:" (Grok Bot: "Criar novo Bot", "Criar chat em grupo" e a lista de bots). */
export function recipientRows(
	agents: readonly Agent[],
	chips: readonly string[],
	query: string,
	groupMode: boolean,
): Row[] {
	const compose = groupMode || chips.length > 0;
	const needle = query.trim().toLowerCase();
	const pool = compose ? groupCandidates(agents) : agents;
	const rows: Row[] = [];
	if (!compose) {
		if (!needle || "criar novo bot".includes(needle)) rows.push({ kind: "new-bot" });
		if (!needle || "criar chat em grupo".includes(needle)) rows.push({ kind: "new-group" });
	}
	for (const agent of pool) {
		if (chips.includes(agent.id)) continue;
		if (needle && !agent.name.toLowerCase().includes(needle)) continue;
		rows.push({ kind: "agent", agent });
	}
	return rows;
}

function placeholderFor(names: readonly string[]): string {
	return names.length === 0 ? "Mensagem para o grupo" : `Mensagem para ${defaultGroupName(names)}`;
}

/**
 * "Para:" (como o Grok Bot): escolha um bot para abrir o chat, ou "Criar chat em grupo" para
 * juntar 2+ bots como chips. O grupo só é criado quando a primeira mensagem é enviada.
 * Desktop e celular usam a mesma tela.
 */
export function NewChatTo({
	agents,
	initialGroupMode = false,
	onCancel,
	onOpenBot,
	onNewBot,
	onSend,
	className,
}: {
	agents: readonly Agent[];
	initialGroupMode?: boolean;
	onCancel: () => void;
	onOpenBot: (id: string) => void;
	onNewBot: () => void;
	onSend: (input: NewGroupInput, text: string) => Promise<boolean>;
	className?: string;
}) {
	const [groupMode, setGroupMode] = useState(initialGroupMode);
	const [chips, setChips] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [text, setText] = useState("");
	const [open, setOpen] = useState(true);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");
	const queryRef = useRef<HTMLInputElement>(null);

	const compose = groupMode || chips.length > 0;
	const chipAgents = chips.flatMap((id) => agents.find((agent) => agent.id === id) ?? []);
	const rows = useMemo(() => recipientRows(agents, chips, query, groupMode), [agents, chips, query, groupMode]);
	const full = chips.length >= GROUP_MAX_MEMBERS;
	const canSend = canCreateGroup(chips) && text.trim().length > 0 && !sending;
	const placeholder = placeholderFor(chipAgents.map((member) => member.name));

	function addChip(id: string) {
		if (full) return;
		setChips((previous) => (previous.includes(id) ? previous : [...previous, id]));
		setQuery("");
		setError("");
		queryRef.current?.focus();
	}

	function removeChip(id: string) {
		setChips((previous) => previous.filter((value) => value !== id));
		queryRef.current?.focus();
	}

	function pick(row: Row) {
		if (row.kind === "new-bot") return onNewBot();
		if (row.kind === "new-group") {
			setGroupMode(true);
			setQuery("");
			queryRef.current?.focus();
			return;
		}
		if (compose) return addChip(row.agent.id);
		onOpenBot(row.agent.id);
	}

	async function submit() {
		if (!canSend) return;
		setSending(true);
		setError("");
		try {
			const color = defaultGroupColor(chipAgents);
			const ok = await onSend(
				{ name: defaultGroupName(chipAgents.map((member) => member.name)), memberIds: chips, ...(color ? { color } : {}) },
				text.trim(),
			);
			if (!ok) setError("Não foi possível criar o grupo. Tente novamente.");
		} finally {
			setSending(false);
		}
	}

	return (
		<section className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)} data-testid="new-chat-to">
			<header className="flex shrink-0 items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2 md:px-6 md:pt-4">
				<Button aria-label="Cancelar" className="size-10 rounded-full" onClick={onCancel} size="icon" type="button" variant="ghost">
					<ArrowLeftIcon className="size-5" />
				</Button>
				<h1 className="font-semibold text-base">{compose ? "Novo chat em grupo" : "Novo chat"}</h1>
			</header>

			<div className="relative mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-4 md:px-6">
				<div className="flex min-h-12 flex-wrap items-center gap-1.5 border-border border-b py-2">
					<label className="shrink-0 text-muted-foreground text-sm" htmlFor="new-chat-to-input">
						Para:
					</label>
					{chipAgents.map((member) => (
						<span className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pr-1 pl-1 text-sm" data-chip={member.id} key={member.id}>
							<AgentAvatar animated={false} bodyColor={member.color} id={member.id} shape={member.shape} size={20} />
							<span className="max-w-32 truncate">{member.name}</span>
							<button
								aria-label={`Remover ${member.name}`}
								className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => removeChip(member.id)}
								type="button"
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
					<input
						aria-controls="new-chat-to-list"
						aria-expanded={open}
						autoComplete="off"
						autoFocus
						className="min-w-24 flex-1 bg-transparent py-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
						id="new-chat-to-input"
						onBlur={() => window.setTimeout(() => setOpen(false), 150)}
						onChange={(event) => {
							setQuery(event.target.value);
							setOpen(true);
						}}
						onFocus={() => setOpen(true)}
						onKeyDown={(event) => {
							if (event.key === "Backspace" && query === "" && chips.length > 0) removeChip(chips[chips.length - 1] as string);
							if (event.key === "Enter" && rows[0]) {
								event.preventDefault();
								pick(rows[0]);
							}
							if (event.key === "Escape") setOpen(false);
						}}
						placeholder={chips.length > 0 ? "Adicionar…" : compose ? "Adicionar ao chat em grupo" : "Nome do bot"}
						ref={queryRef}
						role="combobox"
						value={query}
					/>
				</div>

				{open ? (
					<ul
						aria-label="Sugestões"
						className="mt-1 flex max-h-[min(22rem,50dvh)] flex-col gap-0.5 overflow-y-auto rounded-2xl border border-border bg-popover p-1.5 shadow-md"
						id="new-chat-to-list"
						role="listbox"
					>
						{rows.length === 0 ? (
							<li className="px-3 py-4 text-center text-muted-foreground text-sm">
								{compose ? "Nenhum bot para adicionar" : "Nenhum bot encontrado"}
							</li>
						) : null}
						{rows.map((row) => {
							const key = row.kind === "agent" ? row.agent.id : row.kind;
							return (
								<li key={key} role="presentation">
									<button
										aria-selected={false}
										className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:opacity-50"
										data-row={key}
										disabled={row.kind === "agent" && compose && full}
										onClick={() => pick(row)}
										onMouseDown={(event) => event.preventDefault()}
										role="option"
										type="button"
									>
										{row.kind === "new-bot" ? (
											<span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
												<PlusIcon className="size-4" />
											</span>
										) : row.kind === "new-group" ? (
											<span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
												<UsersIcon className="size-4" />
											</span>
										) : (
											<AgentAvatar animated={false} bodyColor={row.agent.color} id={row.agent.id} shape={row.agent.shape} size={36} />
										)}
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-sm">
												{row.kind === "new-bot" ? "Criar novo Bot" : row.kind === "new-group" ? "Criar chat em grupo" : row.agent.name}
											</span>
											{row.kind === "agent" ? (
												<span className="truncate text-muted-foreground text-xs">
													{compose
														? "Adicionar ao chat em grupo"
														: row.agent.members?.length
															? `${row.agent.members.length} membros`
															: row.agent.description?.trim() || row.agent.snippet || "Bot"}
												</span>
											) : null}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : null}

				<div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm">
					{compose
						? chips.length < GROUP_MIN_MEMBERS
							? `Adicione pelo menos ${GROUP_MIN_MEMBERS} bots. O grupo é criado quando você envia a primeira mensagem.`
							: "O grupo é criado quando você envia a primeira mensagem."
						: "Escolha um bot ou crie um chat em grupo."}
				</div>
			</div>

			<footer className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-6">
				<form
					className="mx-auto flex w-full max-w-3xl flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{error ? (
						<p className="text-center text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
					{/* Mesmo visual do composer do chat (bg-input, duas linhas, enviar embaixo à direita). */}
					<div className="flex flex-col gap-1 rounded-3xl border border-border bg-input p-1">
						<textarea
							aria-label={placeholder}
							className="max-h-40 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground disabled:opacity-60 md:text-sm"
							disabled={!compose || chips.length < GROUP_MIN_MEMBERS}
							onChange={(event) => setText(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void submit();
								}
							}}
							placeholder={placeholder}
							rows={1}
							value={text}
						/>
						<div className="flex justify-end p-1">
							<Button aria-label="Enviar" className="size-9 rounded-full" disabled={!canSend} size="icon" type="submit">
								<ArrowUpIcon className="size-4" />
							</Button>
						</div>
					</div>
				</form>
			</footer>
		</section>
	);
}
