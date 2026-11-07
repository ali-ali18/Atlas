"use client";

import { useState } from "react";
import type { OwnerNoteView } from "@workspace/shared";
import { useTranslations } from "@/lib/i18n/provider";
import { ListLoadError, ListLoading } from "./list-status";
import { createOwnerNote, editOwnerNote, type NotebookApi, pinOwnerNote, realNotebookApi, removeOwnerNote } from "./notebook-actions";
import type { NoteFilter } from "./notebook-model";
import { type NoteFormValue, NotesList } from "./notes-view";
import { NotebookSubSection } from "./sub-section";
import { useLoader } from "./use-loader";

type NotesData = { notes: OwnerNoteView[]; limit: number };

/** Sub-bloco "Notas": carrega ao abrir; "Deste bot" = as do dono + as deste bot, "Todas" = tudo do dono. */
export function NotesBlock({ botId, api = realNotebookApi, defaultOpen = true }: { botId: string; api?: NotebookApi; defaultOpen?: boolean }) {
	return (
		<NotebookSubSection defaultOpen={defaultOpen} id="notes" title={useTranslations().t("notebook.notes.title")}>
			<NotesBody api={api} botId={botId} />
		</NotebookSubSection>
	);
}

function NotesBody({ botId, api }: { botId: string; api: NotebookApi }) {
	const translator = useTranslations();
	const [filter, setFilter] = useState<NoteFilter>("bot");
	const [creating, setCreating] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const { state, reload, setData } = useLoader<NotesData>(() => api.listNotes(filter === "bot" ? { botId } : {}), [botId, filter, api]);

	const closeForm = () => {
		setCreating(false);
		setEditingId(null);
		setFormError(null);
	};
	const replaceNote = (note: OwnerNoteView) => setData((data) => ({ ...data, notes: data.notes.map((item) => (item.id === note.id ? note : item)) }));

	async function create(value: NoteFormValue) {
		setFormBusy(true);
		setFormError(null);
		const result = await createOwnerNote(api, { title: value.title, body: value.body, botId: value.onlyThisBot ? botId : null }, translator);
		setFormBusy(false);
		if (!result.ok) return setFormError(result.message);
		closeForm();
		setData((data) => ({ ...data, notes: [result.value, ...data.notes] }));
	}

	async function edit(id: string, value: NoteFormValue) {
		setFormBusy(true);
		setFormError(null);
		const result = await editOwnerNote(api, id, value, translator);
		setFormBusy(false);
		if (!result.ok) return setFormError(result.message);
		closeForm();
		replaceNote(result.value);
	}

	async function pin(note: OwnerNoteView) {
		setBusyId(note.id);
		setActionError(null);
		const result = await pinOwnerNote(api, note.id, !note.pinned, translator);
		setBusyId(null);
		if (!result.ok) return setActionError(result.message);
		replaceNote(result.value);
	}

	async function remove(note: OwnerNoteView) {
		setBusyId(note.id);
		setActionError(null);
		const result = await removeOwnerNote(api, note.id, translator);
		setBusyId(null);
		if (!result.ok) {
			setActionError(result.message);
			reload();
			return;
		}
		setData((data) => ({ ...data, notes: data.notes.filter((item) => item.id !== note.id) }));
	}

	if (state.status === "loading") return <ListLoading />;
	if (state.status === "error") return <ListLoadError onRetry={reload} />;
	return (
		<NotesList
			actionError={actionError}
			botId={botId}
			busyId={busyId}
			creating={creating}
			editingId={editingId}
			filter={filter}
			formBusy={formBusy}
			formError={formError}
			limit={state.data.limit}
			notes={state.data.notes}
			now={new Date()}
			onCancelForm={closeForm}
			onCreate={create}
			onDelete={remove}
			onEdit={edit}
			onFilter={(next) => {
				setFilter(next);
				closeForm();
			}}
			onPin={pin}
			onStartCreate={() => {
				setEditingId(null);
				setFormError(null);
				setCreating(true);
			}}
			onStartEdit={(id) => {
				setCreating(false);
				setFormError(null);
				setEditingId(id);
			}}
		/>
	);
}
