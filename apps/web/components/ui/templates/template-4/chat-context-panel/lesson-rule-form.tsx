"use client";

import { useState } from "react";
import { LESSON_RULE_KINDS, type LessonRule, type LessonRuleKind } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
	RULE_KIND_HELP,
	RULE_KIND_LABELS,
	RULE_TIGHTEN_NOTE,
	ruleFromFormValues,
	ruleToFormValues,
	type LessonToolOption,
	type RuleFormValues,
} from "./lessons-tab-helpers";

const SELECT_CLASS =
	"h-9 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 px-3 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 md:text-sm";

function ToolSelect({ id, label, value, options, disabled, onChange }: { id: string; label: string; value: string; options: readonly LessonToolOption[]; disabled?: boolean; onChange: (value: string) => void }) {
	const groups = [...new Set(options.map((option) => option.group))];
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<label className="text-muted-foreground text-xs" htmlFor={id}>
				{label}
			</label>
			<select className={SELECT_CLASS} disabled={disabled} id={id} onChange={(event) => onChange(event.target.value)} value={value}>
				<option value="">Escolha uma ferramenta</option>
				{groups.map((group) => (
					<optgroup key={group} label={group}>
						{options
							.filter((option) => option.group === group)
							.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
					</optgroup>
				))}
			</select>
		</div>
	);
}

/**
 * Formulário da regra de uma lição (os 3 tipos). Salva pelo mesmo validador estrito do servidor: só regras que
 * deixam o bot mais cuidadoso. `onSave` devolve a mensagem de erro ou null; `onRemove` só existe com regra ativa.
 */
export function LessonRuleForm({
	lessonId,
	initial,
	tools,
	onSave,
	onRemove,
	onCancel,
}: {
	lessonId: string;
	initial?: LessonRule | null;
	tools: readonly LessonToolOption[];
	onSave: (rule: LessonRule) => Promise<string | null>;
	onRemove?: () => Promise<string | null>;
	onCancel: () => void;
}) {
	const [values, setValues] = useState<RuleFormValues>(() => ruleToFormValues(initial));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (patch: Partial<RuleFormValues>) => setValues((current) => ({ ...current, ...patch }));
	const id = (name: string) => `lesson-rule-${lessonId}-${name}`;

	async function run(action: () => Promise<string | null>) {
		setBusy(true);
		setError(null);
		const failure = await action();
		setBusy(false);
		if (failure) setError(failure);
		else onCancel();
	}

	function save() {
		const built = ruleFromFormValues(values);
		if (!built.ok) {
			setError(built.error);
			return;
		}
		void run(() => onSave(built.rule));
	}

	return (
		<div className="lesson-rule-form flex min-w-0 flex-col gap-3" data-lesson-rule-form>
			<div className="flex min-w-0 flex-col gap-1">
				<label className="text-muted-foreground text-xs" htmlFor={id("kind")}>
					Tipo de regra
				</label>
				<select className={SELECT_CLASS} disabled={busy} id={id("kind")} onChange={(event) => set({ kind: event.target.value as LessonRuleKind })} value={values.kind}>
					{LESSON_RULE_KINDS.map((kind) => (
						<option key={kind} value={kind}>
							{RULE_KIND_LABELS[kind]}
						</option>
					))}
				</select>
				<p className="text-muted-foreground text-xs leading-relaxed">{RULE_KIND_HELP[values.kind]}</p>
			</div>
			<ToolSelect disabled={busy} id={id("tool")} label={values.kind === "require_prior_call" ? "Ferramenta que exige a chamada" : "Ferramenta"} onChange={(tool) => set({ tool })} options={tools} value={values.tool} />
			{values.kind === "require_prior_call" ? <ToolSelect disabled={busy} id={id("requires")} label="Chamada que precisa vir antes" onChange={(requires) => set({ requires })} options={tools} value={values.requires} /> : null}
			{values.kind === "required_args" ? (
				<>
					<div className="flex min-w-0 flex-col gap-1">
						<label className="text-muted-foreground text-xs" htmlFor={id("fields")}>
							Campos obrigatórios
						</label>
						<Input disabled={busy} id={id("fields")} onChange={(event) => set({ fields: event.target.value })} placeholder="cliente.id, pagamento" value={values.fields} />
					</div>
					<div className="flex min-w-0 flex-col gap-1">
						<label className="text-muted-foreground text-xs" htmlFor={id("note")}>
							Motivo (o bot lê quando for barrado)
						</label>
						<Input disabled={busy} id={id("note")} maxLength={160} onChange={(event) => set({ note: event.target.value })} placeholder="O ERP recusa sem a forma de pagamento" value={values.note} />
					</div>
				</>
			) : null}
			<p className="text-muted-foreground text-xs leading-relaxed">{RULE_TIGHTEN_NOTE}</p>
			{error ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap justify-end gap-2">
				{onRemove ? (
					<Button className="mr-auto" disabled={busy} onClick={() => void run(onRemove)} size="sm" variant="ghost">
						Remover regra
					</Button>
				) : null}
				<Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
					Cancelar
				</Button>
				<Button disabled={busy} onClick={save} size="sm">
					{busy ? "Salvando..." : "Salvar regra"}
				</Button>
			</div>
		</div>
	);
}
