"use client";

import { useState } from "react";
import type { LearnedRuleView } from "@workspace/shared";
import { useTranslations } from "@/lib/i18n/provider";
import { ListLoadError, ListLoading } from "./list-status";
import { changeRule, type NotebookApi, realNotebookApi, removeRule } from "./notebook-actions";
import { type RuleFormValue, RulesList } from "./rules-view";
import { NotebookSubSection } from "./sub-section";
import { useLoader } from "./use-loader";

/** Sub-bloco "O que o bot aprendeu": carrega as regras do bot só quando aberto. */
export function RulesBlock({ botId, api = realNotebookApi, defaultOpen = false }: { botId: string; api?: NotebookApi; defaultOpen?: boolean }) {
	const translator = useTranslations();
	return (
		<NotebookSubSection defaultOpen={defaultOpen} id="rules" title={translator.t("notebook.rules.title")}>
			<RulesBody api={api} botId={botId} />
		</NotebookSubSection>
	);
}

function RulesBody({ botId, api }: { botId: string; api: NotebookApi }) {
	const translator = useTranslations();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const { state, reload, setData } = useLoader<LearnedRuleView[]>(() => api.listBotRules(botId), [botId, api]);

	async function save(rule: LearnedRuleView, value: RuleFormValue) {
		setFormBusy(true);
		setFormError(null);
		const note = value.note.trim();
		const result = await changeRule(api, botId, rule.id, { verdict: value.verdict, note: note === "" ? null : note }, translator);
		setFormBusy(false);
		if (!result.ok) return setFormError(result.message);
		setEditingId(null);
		setData((rules) => rules.map((item) => (item.id === rule.id ? result.value : item)));
	}

	async function remove(rule: LearnedRuleView) {
		setBusyId(rule.id);
		setActionError(null);
		const result = await removeRule(api, botId, rule.id, translator);
		setBusyId(null);
		if (!result.ok) {
			setActionError(result.message);
			reload();
			return;
		}
		setData((rules) => rules.filter((item) => item.id !== rule.id));
	}

	if (state.status === "loading") return <ListLoading />;
	if (state.status === "error") return <ListLoadError onRetry={reload} />;
	return (
		<RulesList
			actionError={actionError}
			busyId={busyId}
			editingId={editingId}
			formBusy={formBusy}
			formError={formError}
			now={new Date()}
			onCancelEdit={() => {
				setEditingId(null);
				setFormError(null);
			}}
			onDelete={remove}
			onSave={save}
			onStartEdit={(id) => {
				setFormError(null);
				setEditingId(id);
			}}
			rules={state.data}
		/>
	);
}
