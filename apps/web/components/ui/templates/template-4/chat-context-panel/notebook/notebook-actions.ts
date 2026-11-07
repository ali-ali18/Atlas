import type { LearnedRuleView, MemoryChange, OwnerNoteView, RulePatch, SleepReportView } from "@workspace/shared";
import * as atlasApi from "@/lib/atlas-api";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { noteErrorMessage, ruleErrorMessage, undoErrorMessage, validateNoteDraft, type NoteDraft } from "./notebook-model";

/** O pedaço do cliente que o Caderno usa. Injetável: os testes passam um dublê, a tela usa o cliente real. */
export type NotebookApi = Pick<
	typeof atlasApi,
	| "listNotes"
	| "createNote"
	| "updateNote"
	| "deleteNote"
	| "listBotRules"
	| "patchBotRule"
	| "deleteBotRule"
	| "listSleepReports"
	| "listSleepChanges"
	| "dismissSleepProposal"
	| "undoMemoryChange"
>;

export const realNotebookApi: NotebookApi = atlasApi;

/** Resultado de uma ação: o valor, ou a frase pronta para mostrar ao dono (nunca o erro cru). */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function run<T>(task: () => Promise<T>, onError: (error: unknown) => string): Promise<ActionResult<T>> {
	try {
		return { ok: true, value: await task() };
	} catch (error) {
		return { ok: false, message: onError(error) };
	}
}

export const createOwnerNote = (api: NotebookApi, input: NoteDraft & { botId: string | null }, translator: Translator = defaultTranslator): Promise<ActionResult<OwnerNoteView>> => {
	const invalid = validateNoteDraft(input, translator);
	if (invalid) return Promise.resolve({ ok: false, message: invalid });
	return run(() => api.createNote({ title: input.title.trim(), body: input.body, botId: input.botId }), (error) => noteErrorMessage(error, translator));
};

export const editOwnerNote = (api: NotebookApi, id: string, draft: NoteDraft, translator: Translator = defaultTranslator): Promise<ActionResult<OwnerNoteView>> => {
	const invalid = validateNoteDraft(draft, translator);
	if (invalid) return Promise.resolve({ ok: false, message: invalid });
	return run(() => api.updateNote(id, { title: draft.title.trim(), body: draft.body }), (error) => noteErrorMessage(error, translator));
};

export const pinOwnerNote = (api: NotebookApi, id: string, pinned: boolean, translator: Translator = defaultTranslator): Promise<ActionResult<OwnerNoteView>> =>
	run(() => api.updateNote(id, { pinned }), (error) => noteErrorMessage(error, translator));

export const removeOwnerNote = (api: NotebookApi, id: string, translator: Translator = defaultTranslator): Promise<ActionResult<true>> =>
	run(async () => {
		await api.deleteNote(id);
		return true as const;
	}, (error) => (error instanceof atlasApi.AtlasApiError && error.status === 404 ? translator.t("notebook.notes.error.notFound") : translator.t("notebook.notes.error.deleteFailed")));

export const changeRule = (api: NotebookApi, botId: string, ruleId: string, patch: RulePatch, translator: Translator = defaultTranslator): Promise<ActionResult<LearnedRuleView>> =>
	run(() => api.patchBotRule(botId, ruleId, patch), (error) => ruleErrorMessage(error, translator));

export const removeRule = (api: NotebookApi, botId: string, ruleId: string, translator: Translator = defaultTranslator): Promise<ActionResult<true>> =>
	run(async () => {
		await api.deleteBotRule(botId, ruleId);
		return true as const;
	}, (error) => (error instanceof atlasApi.AtlasApiError && error.status === 404 ? translator.t("notebook.rules.error.notFound") : translator.t("notebook.rules.error.deleteFailed")));

export const undoChange = (api: NotebookApi, changeId: string, translator: Translator = defaultTranslator): Promise<ActionResult<MemoryChange>> =>
	run(() => api.undoMemoryChange(changeId), (error) => undoErrorMessage(error, translator));

export const dismissProposal = (api: NotebookApi, reportId: string, proposalId: string, translator: Translator = defaultTranslator): Promise<ActionResult<SleepReportView>> =>
	run(() => api.dismissSleepProposal(reportId, proposalId), () => translator.t("notebook.review.proposal.dismissError"));
