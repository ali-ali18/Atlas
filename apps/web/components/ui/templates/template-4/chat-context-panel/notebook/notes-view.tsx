"use client";

import { PencilIcon, PinIcon, PinOffIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { OwnerNoteView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { ChatCardDetails } from "@workspace/ui/components/chat-card";
import { Input } from "@workspace/ui/components/input";
import { Spinner } from "@workspace/ui/components/spinner";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { DeletableRow } from "../deletable-row";
import { ActionError, ListEmpty } from "./list-status";
import { type NoteDraft, type NoteFilter, noteMeta, sortNotes } from "./notebook-model";

/** Corpo com mais linhas que isto recolhe atrás de "Ver detalhes". */
const BODY_COLLAPSE_CHARS = 160;

export type NoteFormValue = NoteDraft & { onlyThisBot: boolean };

/** Formulário de nota (criar ou editar). O escopo só se escolhe ao criar; depois não muda. */
export function NoteForm({
	initial,
	askScope,
	busy,
	error,
	onSubmit,
	onCancel,
}: {
	initial?: NoteDraft;
	askScope?: boolean;
	busy: boolean;
	error: string | null;
	onSubmit: (value: NoteFormValue) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [title, setTitle] = useState(initial?.title ?? "");
	const [body, setBody] = useState(initial?.body ?? "");
	const [onlyThisBot, setOnlyThisBot] = useState(false);
	return (
		<form
			className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
			data-notebook-note-form
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit({ title, body, onlyThisBot });
			}}
		>
			<label className="flex flex-col gap-1 text-caption text-muted-foreground">
				{t("notebook.notes.titleLabel")}
				<Input disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder={t("notebook.notes.titlePlaceholder")} value={title} />
			</label>
			<label className="flex flex-col gap-1 text-caption text-muted-foreground">
				{t("notebook.notes.bodyLabel")}
				<Textarea className="min-h-24" disabled={busy} onChange={(event) => setBody(event.target.value)} placeholder={t("notebook.notes.bodyPlaceholder")} value={body} />
			</label>
			{askScope ? (
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="m-0 text-body">{t("notebook.notes.onlyThisBot")}</p>
						<p className="m-0 text-caption text-muted-foreground">{t("notebook.notes.onlyThisBotHint")}</p>
					</div>
					<Switch aria-label={t("notebook.notes.onlyThisBot")} checked={onlyThisBot} disabled={busy} onCheckedChange={setOnlyThisBot} />
				</div>
			) : null}
			<ActionError message={error} />
			<div className="flex items-center justify-end gap-2">
				<Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
					{t("notebook.cancel")}
				</Button>
				<Button disabled={busy} size="sm" type="submit">
					{busy ? <Spinner /> : null}
					{busy ? t("notebook.saving") : t("notebook.save")}
				</Button>
			</div>
		</form>
	);
}

function NoteBody({ body }: { body: string }) {
	const text = "m-0 whitespace-pre-line text-caption text-muted-foreground [overflow-wrap:anywhere]";
	if (body.length <= BODY_COLLAPSE_CHARS && body.split("\n").length <= 3) return <p className={text}>{body}</p>;
	const preview = `${body.slice(0, BODY_COLLAPSE_CHARS).replace(/\s+/g, " ").trim()}…`;
	return (
		<ChatCardDetails summary={<p className={cn(text, "line-clamp-2")}>{preview}</p>}>
			<p className={text}>{body}</p>
		</ChatCardDetails>
	);
}

export type NotesListProps = {
	notes: readonly OwnerNoteView[];
	botId: string;
	now: Date;
	filter: NoteFilter;
	creating: boolean;
	editingId: string | null;
	busyId: string | null;
	formBusy: boolean;
	formError: string | null;
	actionError: string | null;
	limit: number;
	onFilter: (filter: NoteFilter) => void;
	onStartCreate: () => void;
	onStartEdit: (id: string) => void;
	onCancelForm: () => void;
	onCreate: (value: NoteFormValue) => void;
	onEdit: (id: string, value: NoteFormValue) => void;
	onPin: (note: OwnerNoteView) => void;
	onDelete: (note: OwnerNoteView) => void;
};

/** Notas do caderno: filtro, criar, fixadas primeiro, editar, fixar e apagar. Puro: o estado e o cliente vêm de fora. */
export function NotesList(props: NotesListProps) {
	const translator = useTranslations();
	const { t, tn } = translator;
	const sorted = sortNotes(props.notes);
	return (
		<div className="flex flex-col gap-2" data-notebook-notes>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<ButtonGroup aria-label={t("notebook.notes.filterLabel")}>
					{(["bot", "all"] as const).map((value) => (
						<Button aria-pressed={props.filter === value} key={value} onClick={() => props.onFilter(value)} size="sm" type="button" variant={props.filter === value ? "secondary" : "outline"}>
							{value === "bot" ? t("notebook.notes.filterBot") : t("notebook.notes.filterAll")}
						</Button>
					))}
				</ButtonGroup>
				{!props.creating ? (
					<Button onClick={props.onStartCreate} size="sm" type="button" variant="outline">
						<PlusIcon aria-hidden />
						{t("notebook.notes.new")}
					</Button>
				) : null}
			</div>
			{props.creating ? <NoteForm askScope busy={props.formBusy} error={props.formError} onCancel={props.onCancelForm} onSubmit={props.onCreate} /> : null}
			<ActionError message={props.actionError} />
			{sorted.length === 0 && !props.creating ? <ListEmpty>{t("notebook.notes.empty")}</ListEmpty> : null}
			{sorted.length > 0 ? (
				<ul aria-label={t("notebook.notes.label")} className="m-0 flex list-none flex-col gap-2 p-0">
					{sorted.map((note) =>
						props.editingId === note.id ? (
							<li key={note.id}>
								<NoteForm busy={props.formBusy} error={props.formError} initial={{ title: note.title, body: note.body }} onCancel={props.onCancelForm} onSubmit={(value) => props.onEdit(note.id, value)} />
							</li>
						) : (
							<DeletableRow
								busy={props.busyId === note.id}
								cancelLabel={t("notebook.cancel")}
								confirmBody={t("notebook.notes.deleteBody")}
								confirmLabel={t("notebook.notes.deleteConfirm")}
								confirmTitle={t("notebook.notes.deleteTitle", { title: note.title })}
								deleteLabel={t("notebook.notes.delete", { title: note.title })}
								key={note.id}
								onDelete={() => props.onDelete(note)}
								rowId={note.id}
							>
								<div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5" data-note-pinned={note.pinned ? "true" : undefined}>
									<div className="flex min-w-0 items-start gap-1">
										<span className="flex min-w-0 flex-1 items-center gap-1.5">
											{note.pinned ? <PinIcon aria-label={t("notebook.notes.pinned")} className="size-3.5 shrink-0 text-muted-foreground" role="img" /> : null}
											<span className="line-clamp-2 min-w-0 break-words font-medium text-body" data-note-title>{note.title}</span>
										</span>
										<Button
											aria-label={note.pinned ? t("notebook.notes.unpin", { title: note.title }) : t("notebook.notes.pin", { title: note.title })}
											aria-pressed={note.pinned}
											className="-my-1 shrink-0"
											disabled={props.busyId === note.id}
											onClick={() => props.onPin(note)}
											size="icon-sm"
											type="button"
											variant="ghost"
										>
											{note.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
										</Button>
										<Button aria-label={t("notebook.notes.edit", { title: note.title })} className="-my-1 shrink-0" onClick={() => props.onStartEdit(note.id)} size="icon-sm" type="button" variant="ghost">
											<PencilIcon aria-hidden />
										</Button>
									</div>
									<NoteBody body={note.body} />
									<span className="truncate text-caption text-muted-foreground">{noteMeta(note, props.botId, props.now, translator)}</span>
								</div>
							</DeletableRow>
						),
					)}
				</ul>
			) : null}
			{props.notes.length > 0 ? (
				<p className="m-0 text-caption text-muted-foreground">{props.notes.length >= props.limit * 0.8 ? t("notebook.notes.limit", { count: props.notes.length, max: props.limit }) : tn("notebook.notes.count", props.notes.length)}</p>
			) : null}
		</div>
	);
}
