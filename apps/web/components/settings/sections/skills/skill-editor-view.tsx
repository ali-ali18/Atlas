"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import { SettingsPicker } from "@/components/ui/templates/template-4/settings-picker";
import {
	type BotRef,
	type SkillForm,
	type SkillFormErrors,
	SKILL_DESCRIPTION_MAX_CHARS,
	bodyBytes,
	bodyCounterLabel,
	SKILL_BODY_MAX_BYTES,
} from "../../skills-state";
import { SkillMarkdownPreview } from "./skill-markdown-preview";

export type SkillEditorTab = "edit" | "preview";

export type SkillEditorViewProps = {
	mode: "create" | "edit";
	form: SkillForm;
	onChange: (patch: Partial<SkillForm>) => void;
	errors: SkillFormErrors;
	/** Erro devolvido pela API (409 nome repetido/revisão velha, 413 grande). */
	saveError?: string | null;
	tab: SkillEditorTab;
	onTabChange: (tab: SkillEditorTab) => void;
	bots: readonly BotRef[];
	saving?: boolean;
	onSave: () => void;
	onCancel: () => void;
	/** Revisão de uma proposta do agente ("Editar antes"): textos próprios; nome e escopo ficam fixos. */
	review?: boolean;
};

const TABS: { id: SkillEditorTab; label: string }[] = [
	{ id: "edit", label: "Editar" },
	{ id: "preview", label: "Prévia" },
];

function FieldError({ id, message }: { id: string; message?: string }) {
	if (!message) return null;
	return (
		<p className="text-xs text-destructive" id={id} role="alert">
			{message}
		</p>
	);
}

function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<label className="text-sm leading-snug font-medium" htmlFor={htmlFor}>
					{label}
				</label>
				{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
			</div>
			{children}
		</div>
	);
}

/** Editor de skill (só apresentação): campos, corpo com abas Editar/Prévia e salvar. */
export function SkillEditorView({
	mode,
	form,
	onChange,
	errors,
	saveError,
	tab,
	onTabChange,
	bots,
	saving = false,
	onSave,
	onCancel,
	review = false,
}: SkillEditorViewProps) {
	const scopeOptions = [
		{ value: "account", label: "Conta" },
		...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
	];
	const overBody = bodyBytes(form.body) > SKILL_BODY_MAX_BYTES;

	function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		onTabChange(tab === "edit" ? "preview" : "edit");
	}

	return (
		<form
			className="flex flex-col gap-5"
			data-slot="skill-editor"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				onSave();
			}}
		>
			<div className="flex items-center gap-2">
				<Button aria-label="Voltar para a lista de habilidades" onClick={onCancel} size="icon-sm" type="button" variant="ghost">
					<ArrowLeftIcon aria-hidden />
				</Button>
				<h3 className="text-sm font-medium">{review ? "Revisar habilidade proposta" : mode === "create" ? "Nova habilidade" : "Editar habilidade"}</h3>
			</div>

			<Field htmlFor="skill-name" label="Nome">
				<Input
					aria-describedby={errors.name ? "skill-name-error" : "skill-name-help"}
					aria-invalid={errors.name ? true : undefined}
					autoComplete="off"
					className="font-mono"
					disabled={review && mode === "edit"}
					id="skill-name"
					onChange={(event) => onChange({ name: event.target.value })}
					placeholder="relatorio-semanal"
					value={form.name}
				/>
				<p className="text-xs text-muted-foreground" id="skill-name-help">
					Identificador curto: letras minúsculas, números e hífens.
				</p>
				<FieldError id="skill-name-error" message={errors.name} />
			</Field>

			<Field
				hint={`${form.description.length}/${SKILL_DESCRIPTION_MAX_CHARS}`}
				htmlFor="skill-description"
				label="Descrição"
			>
				<Input
					aria-describedby={errors.description ? "skill-description-error" : "skill-description-help"}
					aria-invalid={errors.description ? true : undefined}
					id="skill-description"
					onChange={(event) => onChange({ description: event.target.value })}
					placeholder="Quando o agente deve usar esta habilidade"
					value={form.description}
				/>
				<p className="text-xs text-muted-foreground" id="skill-description-help">
					O agente só enxerga esta linha até decidir ler a habilidade inteira.
				</p>
				<FieldError id="skill-description-error" message={errors.description} />
			</Field>

			<div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
				<div className="flex min-w-0 max-w-prose flex-col gap-1">
					<p className="text-sm leading-snug font-medium" id="skill-scope-label">
						Escopo
					</p>
					<p className="text-sm leading-snug text-muted-foreground">
						{mode === "edit" || review
							? review
								? "O escopo vem da proposta do agente."
								: "O escopo não muda depois de criada."
							: "Conta vale para todos os bots; um bot restringe a habilidade a ele."}
					</p>
				</div>
				<SettingsPicker
					aria-labelledby="skill-scope-label"
					className="w-full sm:w-60"
					disabled={mode === "edit" || review}
					onChange={(value) => onChange({ botId: value === "account" ? null : value.slice(4) })}
					options={scopeOptions}
					value={form.botId ? `bot:${form.botId}` : "account"}
				/>
			</div>

			<Field htmlFor="skill-tools" label="Ferramentas sugeridas (opcional)">
				<Input
					aria-describedby={errors.tools ? "skill-tools-error" : "skill-tools-help"}
					aria-invalid={errors.tools ? true : undefined}
					id="skill-tools"
					onChange={(event) => onChange({ toolsText: event.target.value })}
					placeholder="github, calendar"
					value={form.toolsText}
				/>
				<p className="text-xs text-muted-foreground" id="skill-tools-help">
					Separe por vírgula. É só uma dica para o agente: não libera nenhuma ferramenta.
				</p>
				<FieldError id="skill-tools-error" message={errors.tools} />
			</Field>

			<div className="flex flex-col gap-1.5">
				<div className="flex items-end justify-between gap-3">
					<div
						aria-label="Corpo da habilidade"
						className="flex gap-1 rounded-3xl bg-input/50 p-0.5"
						onKeyDown={onTabKeyDown}
						role="tablist"
					>
						{TABS.map((item) => (
							<button
								aria-controls={`skill-body-${item.id}`}
								aria-selected={tab === item.id}
								className={cn(
									"h-7 rounded-3xl px-3 text-xs font-medium text-muted-foreground outline-none transition-colors",
									"focus-visible:ring-3 focus-visible:ring-ring/30",
									tab === item.id && "bg-background text-foreground shadow-sm",
								)}
								id={`skill-body-tab-${item.id}`}
								key={item.id}
								onClick={() => onTabChange(item.id)}
								role="tab"
								tabIndex={tab === item.id ? 0 : -1}
								type="button"
							>
								{item.label}
							</button>
						))}
					</div>
					<span className={cn("text-xs text-muted-foreground", overBody && "text-destructive")}>
						{bodyCounterLabel(form.body)}
					</span>
				</div>
				{tab === "edit" ? (
					<div aria-labelledby="skill-body-tab-edit" id="skill-body-edit" role="tabpanel">
						<Textarea
							aria-describedby={errors.body ? "skill-body-error" : undefined}
							aria-invalid={errors.body ? true : undefined}
							aria-label="Corpo da habilidade em Markdown"
							className="min-h-64 font-mono text-xs leading-relaxed"
							onChange={(event) => onChange({ body: event.target.value })}
							placeholder={"# Passos\n\n1. Faça isto\n2. Depois isto"}
							spellCheck={false}
							value={form.body}
						/>
					</div>
				) : (
					<div
						aria-labelledby="skill-body-tab-preview"
						className="min-h-64 rounded-2xl border border-border/60 p-4"
						id="skill-body-preview"
						role="tabpanel"
					>
						<SkillMarkdownPreview markdown={form.body} />
					</div>
				)}
				<FieldError id="skill-body-error" message={errors.body} />
			</div>

			{saveError ? (
				<p className="text-sm text-destructive" role="alert">
					{saveError}
				</p>
			) : null}

			<div className="flex justify-end gap-2">
				<Button onClick={onCancel} type="button" variant="outline">
					Cancelar
				</Button>
				<Button disabled={saving} type="submit">
					{saving ? "Salvando…" : review ? "Aprovar e salvar" : "Salvar"}
				</Button>
			</div>
		</form>
	);
}
