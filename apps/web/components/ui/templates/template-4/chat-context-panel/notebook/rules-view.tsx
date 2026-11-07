"use client";

import { PencilIcon } from "lucide-react";
import { useState } from "react";
import type { LearnedRuleView } from "@workspace/shared";
import { RULE_VERDICTS } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { Input } from "@workspace/ui/components/input";
import { Spinner } from "@workspace/ui/components/spinner";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { DeletableRow } from "./deletable-row";
import { ActionError, ListEmpty } from "./list-status";
import { capitalize, ruleEffectPhrase, ruleMatchLabel, ruleSourceLabel, ruleVerdictLabel } from "./notebook-model";

export type RuleFormValue = { verdict: LearnedRuleView["verdict"]; note: string };

/** Edição de uma regra: o que vale (Pode fazer / Sempre perguntar / Nunca) e a observação. O alvo da regra não muda. */
function RuleForm({ rule, busy, error, onSubmit, onCancel }: { rule: LearnedRuleView; busy: boolean; error: string | null; onSubmit: (value: RuleFormValue) => void; onCancel: () => void }) {
	const t = useT();
	const translator = useTranslations();
	const [verdict, setVerdict] = useState(rule.verdict);
	const [note, setNote] = useState(rule.note ?? "");
	return (
		<form
			className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
			data-notebook-rule-form
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit({ verdict, note });
			}}
		>
			<p className="m-0 font-medium text-body">{capitalize(ruleEffectPhrase(rule.effect, translator))}</p>
			<ButtonGroup aria-label={t("notebook.rules.verdictLabel")} className="w-full">
				{RULE_VERDICTS.map((value) => (
					<Button aria-pressed={verdict === value} className="flex-1" disabled={busy} key={value} onClick={() => setVerdict(value)} size="sm" type="button" variant={verdict === value ? "secondary" : "outline"}>
						{ruleVerdictLabel(value, translator)}
					</Button>
				))}
			</ButtonGroup>
			<label className="flex flex-col gap-1 text-caption text-muted-foreground">
				{t("notebook.rules.noteLabel")}
				<Input disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder={t("notebook.rules.notePlaceholder")} value={note} />
			</label>
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

const VERDICT_TONE: Record<LearnedRuleView["verdict"], string> = {
	run: "bg-success/10 text-success",
	approve: "bg-info/10 text-info",
	deny: "bg-destructive/10 text-destructive",
};

export type RulesListProps = {
	rules: readonly LearnedRuleView[];
	now: Date;
	editingId: string | null;
	busyId: string | null;
	formBusy: boolean;
	formError: string | null;
	actionError: string | null;
	onStartEdit: (id: string) => void;
	onCancelEdit: () => void;
	onSave: (rule: LearnedRuleView, value: RuleFormValue) => void;
	onDelete: (rule: LearnedRuleView) => void;
};

/** Regras que o bot aprendeu: o que vale, quando, a origem; editar e apagar. Puro. */
export function RulesList(props: RulesListProps) {
	const translator = useTranslations();
	const { t } = translator;
	if (props.rules.length === 0) return <ListEmpty>{t("notebook.rules.empty")}</ListEmpty>;
	return (
		<div className="flex flex-col gap-2" data-notebook-rules>
			<ActionError message={props.actionError} />
			<ul aria-label={t("notebook.rules.label")} className="m-0 flex list-none flex-col gap-2 p-0">
				{props.rules.map((rule) => {
					const what = ruleEffectPhrase(rule.effect, translator);
					if (props.editingId === rule.id) {
						return (
							<li key={rule.id}>
								<RuleForm busy={props.formBusy} error={props.formError} onCancel={props.onCancelEdit} onSubmit={(value) => props.onSave(rule, value)} rule={rule} />
							</li>
						);
					}
					const onlyFor = ruleMatchLabel(rule.match, translator);
					return (
						<DeletableRow
							busy={props.busyId === rule.id}
							cancelLabel={t("notebook.cancel")}
							confirmBody={t("notebook.rules.deleteBody", { what })}
							confirmLabel={t("notebook.rules.deleteConfirm")}
							confirmTitle={t("notebook.rules.deleteTitle")}
							deleteLabel={t("notebook.rules.delete", { what })}
							key={rule.id}
							onDelete={() => props.onDelete(rule)}
							rowId={rule.id}
						>
							<div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
								<div className="flex min-w-0 items-start gap-1">
									<span className="min-w-0 flex-1 font-medium text-body [overflow-wrap:anywhere]">{t("notebook.rules.when", { what })}</span>
									<Button aria-label={t("notebook.rules.edit", { what })} className="-my-1 shrink-0" onClick={() => props.onStartEdit(rule.id)} size="icon-sm" type="button" variant="ghost">
										<PencilIcon aria-hidden />
									</Button>
								</div>
								<span className={`w-fit rounded-full px-2 py-0.5 text-caption ${VERDICT_TONE[rule.verdict]}`} data-rule-verdict={rule.verdict}>
									{ruleVerdictLabel(rule.verdict, translator)}
								</span>
								{onlyFor ? <span className="truncate text-caption text-muted-foreground">{onlyFor}</span> : null}
								{rule.note ? <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{rule.note}</span> : null}
								<span className="truncate text-caption text-muted-foreground">{ruleSourceLabel(rule, props.now, translator)}</span>
							</div>
						</DeletableRow>
					);
				})}
			</ul>
		</div>
	);
}
