"use client";

import { MessageSquareQuoteIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { MemoryEntry } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Textarea } from "@workspace/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { memoryFixDraft, memoryOriginLabel, memoryRelativeDate } from "./memory-tab-helpers";

/** Campo de texto com Salvar/Cancelar (edição inline e "Adicionar"); mostra a recusa do servidor logo abaixo. */
function MemoryTextForm({
	initial = "",
	label,
	submitLabel = "Salvar",
	onSubmit,
	onCancel,
}: {
	initial?: string;
	label: string;
	submitLabel?: string;
	/** Devolve a mensagem de erro ou null quando salvou. */
	onSubmit: (content: string) => Promise<string | null>;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const empty = value.trim().length === 0;

	async function submit() {
		if (empty || busy) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit(value.trim());
		setBusy(false);
		if (failure) setError(failure);
		else onCancel();
	}

	return (
		<div className="flex min-w-0 flex-col gap-2" data-memory-form>
			<Textarea
				aria-label={label}
				autoFocus
				className="min-h-20"
				disabled={busy}
				maxLength={2000}
				onChange={(event) => setValue(event.target.value)}
				value={value}
			/>
			{error ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
					Cancelar
				</Button>
				<Button disabled={empty || busy} onClick={() => void submit()} size="sm">
					{busy ? "Salvando..." : submitLabel}
				</Button>
			</div>
		</div>
	);
}

function MemoryItem({
	entry,
	now,
	onEdit,
	onRemove,
	onFixInChat,
}: {
	entry: MemoryEntry;
	now: Date;
	onEdit: (entryId: string, content: string) => Promise<string | null>;
	onRemove: (entryId: string) => Promise<string | null>;
	onFixInChat?: (draft: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);

	if (editing) {
		return (
			<li className="rounded-2xl border border-border bg-card p-3" data-memory-item={entry.id}>
				<MemoryTextForm initial={entry.content} label="Editar memória" onCancel={() => setEditing(false)} onSubmit={(content) => onEdit(entry.id, content)} />
			</li>
		);
	}

	return (
		<li className="flex min-w-0 items-start gap-2 rounded-2xl border border-border bg-card py-2.5 pr-1.5 pl-3" data-memory-item={entry.id}>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="break-words text-sm leading-relaxed whitespace-pre-wrap">{entry.content}</p>
				<p className="text-muted-foreground text-xs">
					{memoryOriginLabel(entry.source)} · {memoryRelativeDate(entry.updatedAt, now)}
				</p>
				{removeError ? (
					<p className="text-destructive text-xs" role="alert">
						{removeError}
					</p>
				) : null}
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button aria-label="Ações da memória" className="shrink-0 text-muted-foreground" size="icon-sm" variant="ghost" />}>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => setEditing(true)}>
						<PencilIcon />
						Editar
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => onFixInChat?.(memoryFixDraft(entry.content))}>
						<MessageSquareQuoteIcon />
						Corrigir no chat
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={async () => {
							setRemoveError(null);
							setRemoveError(await onRemove(entry.id));
						}}
						variant="destructive"
					>
						<Trash2Icon />
						Apagar
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/** Botão do cabeçalho da seção: no celular só o ícone (nome no tooltip); no desktop ícone e texto. */
export function SectionAction({ icon: Icon, label, onClick, disabled }: { icon: typeof PlusIcon; label: string; onClick?: () => void; disabled?: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button aria-label={label} className="max-md:w-8 max-md:px-0" disabled={disabled} onClick={onClick} size="sm" type="button" variant="outline">
						<Icon aria-hidden />
						<span className="max-md:hidden">{label}</span>
					</Button>
				}
			/>
			<TooltipContent className="md:hidden">{label}</TooltipContent>
		</Tooltip>
	);
}

/** Uma seção da aba (perfil do usuário ou memória do bot): título, nota, itens e "Adicionar". */
export function MemorySection({
	id,
	title,
	note,
	emptyText,
	entries,
	now,
	onAdd,
	onEdit,
	onRemove,
	onFixInChat,
	leadingAction,
}: {
	id: string;
	title: string;
	/** Botão que vai no mesmo grupo, antes de "Adicionar" (ex.: revisar memórias). */
	leadingAction?: ReactNode;
	note?: string;
	emptyText: string;
	entries: MemoryEntry[];
	now: Date;
	onAdd: (content: string) => Promise<string | null>;
	onEdit: (entryId: string, content: string) => Promise<string | null>;
	onRemove: (entryId: string) => Promise<string | null>;
	onFixInChat?: (draft: string) => void;
}) {
	const [adding, setAdding] = useState(false);

	return (
		<section aria-labelledby={id} className="flex min-w-0 flex-col gap-2" data-memory-section={id}>
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 flex-col">
					<h3 className="font-medium text-muted-foreground text-xs" id={id}>
						{title}
					</h3>
					{note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
				</div>
				{adding ? null : (
					<ButtonGroup>
						{leadingAction}
						<SectionAction icon={PlusIcon} label="Adicionar" onClick={() => setAdding(true)} />
					</ButtonGroup>
				)}
			</div>
			{adding ? (
				<div className="rounded-2xl border border-border bg-card p-3">
					<MemoryTextForm label={`Nova memória: ${title}`} onCancel={() => setAdding(false)} onSubmit={onAdd} submitLabel="Adicionar" />
				</div>
			) : null}
			{entries.length === 0 && !adding ? (
				<p className="px-1 py-3 text-center text-muted-foreground text-xs leading-relaxed">{emptyText}</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{entries.map((entry) => (
						<MemoryItem entry={entry} key={entry.id} now={now} onEdit={onEdit} onFixInChat={onFixInChat} onRemove={onRemove} />
					))}
				</ul>
			)}
		</section>
	);
}
