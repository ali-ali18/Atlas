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
import { useTranslations } from "@/lib/i18n/provider";

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

const TABS = [
	{ id: "edit", label: "settings.skills.editor.tabEdit" },
	{ id: "preview", label: "settings.skills.editor.tabPreview" },
] as const;

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
	const translator = useTranslations();
	const { t } = translator;
	const scopeOptions = [
		{ value: "account", label: t("settings.skills.scopeAccount") },
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
				<Button aria-label={t("settings.skills.backAria")} onClick={onCancel} size="icon-sm" type="button" variant="ghost">
					<ArrowLeftIcon aria-hidden />
				</Button>
				<h3 className="text-sm font-medium">{review ? t("settings.skills.editor.review") : mode === "create" ? t("settings.skills.editor.create") : t("settings.skills.editor.edit")}</h3>
			</div>

			<Field htmlFor="skill-name" label={t("settings.skills.editor.name")}>
				<Input
					aria-describedby={errors.name ? "skill-name-error" : "skill-name-help"}
					aria-invalid={errors.name ? true : undefined}
					autoComplete="off"
					className="font-mono"
					disabled={review && mode === "edit"}
					id="skill-name"
					onChange={(event) => onChange({ name: event.target.value })}
					placeholder={t("settings.skills.editor.namePlaceholder")}
					value={form.name}
				/>
				<p className="text-xs text-muted-foreground" id="skill-name-help">
					{t("settings.skills.editor.nameHelp")}
				</p>
				<FieldError id="skill-name-error" message={errors.name} />
			</Field>

			<Field
				hint={`${form.description.length}/${SKILL_DESCRIPTION_MAX_CHARS}`}
				htmlFor="skill-description"
				label={t("settings.skills.editor.description")}
			>
				<Input
					aria-describedby={errors.description ? "skill-description-error" : "skill-description-help"}
					aria-invalid={errors.description ? true : undefined}
					id="skill-description"
					onChange={(event) => onChange({ description: event.target.value })}
					placeholder={t("settings.skills.editor.descriptionPlaceholder")}
					value={form.description}
				/>
				<p className="text-xs text-muted-foreground" id="skill-description-help">
					{t("settings.skills.editor.descriptionHelp")}
				</p>
				<FieldError id="skill-description-error" message={errors.description} />
			</Field>

			<div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
				<div className="flex min-w-0 max-w-prose flex-col gap-1">
					<p className="text-sm leading-snug font-medium" id="skill-scope-label">
						{t("settings.skills.editor.scope")}
					</p>
					<p className="text-sm leading-snug text-muted-foreground">
						{mode === "edit" || review
							? review
								? t("settings.skills.editor.scopeReview")
								: t("settings.skills.editor.scopeFixed")
							: t("settings.skills.editor.scopeCreate")}
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

			<Field htmlFor="skill-tools" label={t("settings.skills.editor.tools")}>
				<Input
					aria-describedby={errors.tools ? "skill-tools-error" : "skill-tools-help"}
					aria-invalid={errors.tools ? true : undefined}
					id="skill-tools"
					onChange={(event) => onChange({ toolsText: event.target.value })}
					placeholder={t("settings.skills.editor.toolsPlaceholder")}
					value={form.toolsText}
				/>
				<p className="text-xs text-muted-foreground" id="skill-tools-help">
					{t("settings.skills.editor.toolsHelp")}
				</p>
				<FieldError id="skill-tools-error" message={errors.tools} />
			</Field>

			<div className="flex flex-col gap-1.5">
				<div className="flex items-end justify-between gap-3">
					<div
						aria-label={t("settings.skills.editor.bodyAria")}
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
								{t(item.label)}
							</button>
						))}
					</div>
					<span className={cn("text-xs text-muted-foreground", overBody && "text-destructive")}>
						{bodyCounterLabel(form.body, translator)}
					</span>
				</div>
				{tab === "edit" ? (
					<div aria-labelledby="skill-body-tab-edit" id="skill-body-edit" role="tabpanel">
						<Textarea
							aria-describedby={errors.body ? "skill-body-error" : undefined}
							aria-invalid={errors.body ? true : undefined}
							aria-label={t("settings.skills.editor.bodyTextAria")}
							className="min-h-64 font-mono text-xs leading-relaxed"
							onChange={(event) => onChange({ body: event.target.value })}
							placeholder={t("settings.skills.editor.bodyPlaceholder")}
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
					{t("settings.skills.editor.cancel")}
				</Button>
				<Button disabled={saving} type="submit">
					{saving ? t("settings.skills.editor.saving") : review ? t("settings.skills.editor.approve") : t("settings.skills.editor.save")}
				</Button>
			</div>
		</form>
	);
}
