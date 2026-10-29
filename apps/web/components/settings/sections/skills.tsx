"use client";

import { useEffect, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { useSkills, type SaveSkillResult } from "@/hooks/use-skills";
import type { BuiltinSkillView, SkillDocView } from "@/lib/atlas-api";
import { resolveSkillProposal } from "@/lib/atlas-api";
import { formToProposalMarkdown, proposalErrorMessage } from "@/components/ai-elements/skills";
import { registerUnsavedGuard, runUnlessUnsaved } from "@/lib/unsaved-guard";
import { downloadTextFile } from "@/lib/download-text";
import {
	emitSkillProposalResolved,
	takePendingSkillDraft,
	type SkillProposalResolveContext,
} from "@/lib/skill-draft-handoff";
import {
	type BotRef,
	EMPTY_SKILL_FORM,
	type SkillForm,
	type SkillFormErrors,
	discardConfirm,
	SCOPE_ALL,
	deleteConfirmText,
	deleteDraftsConfirmText,
	draftScopeParams,
	draftsInScope,
	isSkillFormDirty,
	exportFileName,
	formFromSkill,
	skillErrorMessage,
	validateSkillForm,
} from "../skills-state";
import { SkillEditorView, type SkillEditorTab } from "./skills/skill-editor-view";
import { BuiltinSkillDetail } from "./skills/builtin-skill-view";
import { SkillsListView } from "./skills/skills-list-view";
import { useTranslations } from "@/lib/i18n/provider";
import { PublishSkillPanel } from "@/components/ui/templates/template-4/marketplace/publish-skill";

/** Estado do formulário do editor; a tela em si é `SkillEditorView`. */
function SkillEditor({
	editing,
	initial,
	bots,
	save,
	resolve,
	onDone,
	onCancel,
}: {
	editing: SkillDocView | null;
	initial: SkillForm;
	bots: readonly BotRef[];
	save: (editing: SkillDocView | null, form: SkillForm) => Promise<SaveSkillResult>;
	/** "Editar antes": salvar resolve a proposta do chat (aprovada, com este documento) em vez de criar direto. */
	resolve?: SkillProposalResolveContext;
	onDone: (skill: SkillDocView | null) => void;
	onCancel: () => void;
}) {
	const translator = useTranslations();
	const discard = discardConfirm(translator);
	const [form, setForm] = useState(initial);
	const [errors, setErrors] = useState<SkillFormErrors>({});
	const [tab, setTab] = useState<SkillEditorTab>("edit");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [askingDiscard, setAskingDiscard] = useState(false);
	const leaveRef = useRef<(() => void) | null>(null);
	const dirtyRef = useRef(false);
	dirtyRef.current = isSkillFormDirty(initial, form);

	// Esc, fechar o modal, trocar de seção e Voltar passam por aqui: com alterações, pergunta antes.
	useEffect(
		() =>
			registerUnsavedGuard({
				isDirty: () => dirtyRef.current,
				ask: (proceed) => {
					leaveRef.current = proceed;
					setAskingDiscard(true);
				},
			}),
		[],
	);

	async function onSave() {
		const checked = validateSkillForm(form, translator);
		setErrors(checked.ok ? {} : checked.errors);
		setSaveError(null);
		if (!checked.ok) return;
		setSaving(true);
		if (resolve) {
			try {
				await resolveSkillProposal({
					conversationId: resolve.conversationId,
					proposalId: resolve.proposal.proposalId,
					decision: "approved",
					markdown: formToProposalMarkdown(form),
				});
				dirtyRef.current = false;
				emitSkillProposalResolved({ proposalId: resolve.proposal.proposalId, status: "approved" });
				onDone(null);
			} catch (cause) {
				setSaveError(proposalErrorMessage(cause));
			} finally {
				setSaving(false);
			}
			return;
		}
		const result = await save(editing, form);
		setSaving(false);
		if (result.ok) onDone(result.skill);
		else setSaveError(result.error);
	}

	return (
		<>
		<SkillEditorView
			bots={bots}
			errors={errors}
			form={form}
			mode={editing ? "edit" : "create"}
			onCancel={() => runUnlessUnsaved(onCancel)}
			onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
			onSave={() => void onSave()}
			onTabChange={setTab}
			saveError={saveError}
			review={Boolean(resolve)}
			saving={saving}
			tab={tab}
		/>
		<AlertDialog onOpenChange={(open) => !open && setAskingDiscard(false)} open={askingDiscard}>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>{discard.title}</AlertDialogTitle>
					<AlertDialogDescription>{discard.description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{discard.keep}</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							dirtyRef.current = false;
							const proceed = leaveRef.current;
							leaveRef.current = null;
							proceed?.();
						}}
					>
						{discard.discard}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
		</>
	);
}

type View =
	| { kind: "list" }
	| { kind: "builtin"; skill: BuiltinSkillView }
	| { kind: "editor"; editing: SkillDocView | null; initial: SkillForm; resolve?: SkillProposalResolveContext };

/** Seção Habilidades: lista com busca/escopo, editor, import/export e apagar com confirmação. */
export function SkillsSettings() {
	const translator = useTranslations();
	const { t } = translator;
	const data = useSkills();
	const [view, setView] = useState<View>({ kind: "list" });
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState(SCOPE_ALL);
	const [draftsOpen, setDraftsOpen] = useState(false);
	const [notice, setNotice] = useState<SkillDocView | null>(null);
	const [toDelete, setToDelete] = useState<SkillDocView | null>(null);
	const [confirmDrafts, setConfirmDrafts] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [duplicating, setDuplicating] = useState(false);
	const [publishing, setPublishing] = useState<SkillDocView | null>(null);

	// "Editar antes" do card do chat deixa um rascunho para abrir o editor já preenchido.
	useEffect(() => {
		const pending = takePendingSkillDraft();
		if (pending) setView({ kind: "editor", editing: null, initial: pending.form, resolve: pending.resolve });
	}, []);

	async function openEditor(skill: SkillDocView) {
		setLocalError(null);
		try {
			// A lista vem sem corpo: busca a skill inteira para editar.
			const full = await data.loadFull(skill.id);
			setView({ kind: "editor", editing: full, initial: formFromSkill(full) });
		} catch (cause) {
			setLocalError(skillErrorMessage(cause, translator));
		}
	}

	async function exportSkill(skill: SkillDocView) {
		setLocalError(null);
		try {
			downloadTextFile(exportFileName(skill), await data.exportText(skill.id));
		} catch (cause) {
			setLocalError(skillErrorMessage(cause, translator));
		}
	}

	async function importFile(file: File) {
		setLocalError(null);
		const imported = await data.importMarkdown(await file.text());
		if (imported) {
			setNotice(imported);
			setDraftsOpen(true);
		}
	}

	async function confirmDelete() {
		if (!toDelete) return;
		const skill = toDelete;
		setToDelete(null);
		if (await data.remove(skill)) setNotice((current) => (current?.id === skill.id ? null : current));
	}

	async function confirmDeleteDrafts() {
		setConfirmDrafts(false);
		await data.removeDrafts(draftScopeParams(scope));
	}

	async function duplicate(builtin: BuiltinSkillView) {
		setDuplicating(true);
		setLocalError(null);
		const result = await data.duplicateBuiltin(builtin);
		setDuplicating(false);
		if (!result.ok) return setLocalError(result.error);
		await openEditor(result.skill);
	}

	if (view.kind === "builtin") {
		return (
			<BuiltinSkillDetail
				duplicating={duplicating}
				error={localError}
				onBack={() => {
					setLocalError(null);
					setView({ kind: "list" });
				}}
				onDuplicate={() => void duplicate(view.skill)}
				skill={view.skill}
			/>
		);
	}

	if (view.kind === "editor") {
		return (
			<SkillEditor
				bots={data.bots}
				editing={view.editing}
				initial={view.initial}
				onCancel={() => setView({ kind: "list" })}
				onDone={() => setView({ kind: "list" })}
				resolve={view.resolve}
				save={data.save}
			/>
		);
	}

	const confirm = toDelete ? deleteConfirmText(toDelete, translator) : null;
	const draftCount = draftsInScope(data.skills, scope).length;
	const draftsConfirm = deleteDraftsConfirmText(draftCount, translator);
	return (
		<>
			<SkillsListView
				actionError={localError ?? data.actionError}
				bots={data.bots}
				builtins={data.builtins}
				onOpenBuiltin={(skill) => {
					setLocalError(null);
					setView({ kind: "builtin", skill });
				}}
				draftsOpen={draftsOpen}
				error={data.error}
				loading={data.loading}
				notice={notice}
				onCreate={() => setView({ kind: "editor", editing: null, initial: EMPTY_SKILL_FORM })}
				onDelete={setToDelete}
				onDeleteDrafts={() => setConfirmDrafts(true)}
				onDismissNotice={() => setNotice(null)}
				onDraftsOpenChange={setDraftsOpen}
				onEdit={(skill) => void openEditor(skill)}
				onExport={(skill) => void exportSkill(skill)}
				onPublish={setPublishing}
				onImportFile={(file) => void importFile(file)}
				onQueryChange={setQuery}
				onRetry={data.reload}
				onScopeChange={setScope}
				onToggle={(skill, enabled) => void data.toggle(skill, enabled)}
				query={query}
				scope={scope}
				skills={data.skills}
			/>
			<PublishSkillPanel loadFull={data.loadFull} onClose={() => setPublishing(null)} skill={publishing} />
			<AlertDialog onOpenChange={(open) => !open && setToDelete(null)} open={toDelete !== null}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
						<AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings.skills.editor.cancel")}</AlertDialogCancel>
						<AlertDialogAction onClick={() => void confirmDelete()}>{t("settings.skills.delete")}</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog onOpenChange={setConfirmDrafts} open={confirmDrafts}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{draftsConfirm.title}</AlertDialogTitle>
						<AlertDialogDescription>{draftsConfirm.description}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings.skills.editor.cancel")}</AlertDialogCancel>
						<AlertDialogAction onClick={() => void confirmDeleteDrafts()}>{t("settings.skills.deleteDrafts")}</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
