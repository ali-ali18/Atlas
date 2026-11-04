"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { RoutineLimits, RoutineLimitsPatch } from "@workspace/shared";

import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import { useTranslations } from "@/lib/i18n/provider";
import { DEFAULT_ROUTINE_STEPS, draftToLimitsPatch, limitsToDraft, routineLimitsSummary } from "./routine-limits";

export type RoutineLimitsFieldProps = {
	limits?: RoutineLimits;
	/** Grava o patch (`null` = volta ao padrão); devolve o erro para mostrar, ou nada. */
	onSave: (patch: RoutineLimitsPatch | null) => Promise<{ error: string } | void>;
	defaultOpen?: boolean;
};

/**
 * Limites por execução da rotina (motor v3, D4): a frase fica sempre à vista ("Até 40 passos por execução · Sem teto de
 * gasto") e o formulário fica recolhido, como reserva (o normal é ajustar pelo chat). Salva só no botão.
 */
export function RoutineLimitsField({ limits, onSave, defaultOpen = false }: RoutineLimitsFieldProps) {
	const translator = useTranslations();
	const { t } = translator;
	const [draft, setDraft] = useState(() => limitsToDraft(limits));
	const [invalid, setInvalid] = useState<"steps" | "cost" | null>(null);
	const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
	const [error, setError] = useState<string | null>(null);
	const key = `${limits?.maxSteps ?? ""}|${limits?.maxCostUsd ?? ""}`;
	// O agente mudou os limites pelo chat: o formulário acompanha.
	useEffect(() => setDraft(limitsToDraft(limits)), [key]); // eslint-disable-line react-hooks/exhaustive-deps

	async function save(patch: RoutineLimitsPatch | null) {
		setStatus("saving");
		setError(null);
		const result = await onSave(patch).catch(() => ({ error: t("routines.limits.saveFailed") }));
		if (result && "error" in result) {
			setError(result.error);
			setStatus("idle");
			return;
		}
		setStatus("saved");
	}

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const parsed = draftToLimitsPatch(draft);
		if (!parsed.ok) {
			setInvalid(parsed.field);
			return;
		}
		setInvalid(null);
		void save(parsed.patch);
	}

	return (
		<Collapsible data-slot="routine-limits" defaultOpen={defaultOpen}>
			<CollapsibleTrigger className="group/limits flex w-full min-w-0 items-center gap-2 rounded-card py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-xs text-muted-foreground">{t("routines.limits.title")}</span>
					<span className="text-body text-foreground" data-slot="routine-limits-summary">
						{routineLimitsSummary(limits, translator)}
					</span>
				</span>
				<ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/limits:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<form className="mt-2 space-y-3" noValidate onSubmit={submit}>
					<p className="text-xs text-muted-foreground">{t("routines.limits.help")}</p>
					<Field>
						<FieldLabel className="text-xs text-muted-foreground" htmlFor="routine-limit-steps">{t("routines.limits.stepsLabel")}</FieldLabel>
						<Input
							aria-invalid={invalid === "steps" || undefined}
							id="routine-limit-steps"
							inputMode="numeric"
							onChange={(event) => setDraft((current) => ({ ...current, steps: event.target.value }))}
							placeholder={String(DEFAULT_ROUTINE_STEPS)}
							value={draft.steps}
						/>
						<p className={invalid === "steps" ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={invalid === "steps" ? "alert" : undefined}>
							{invalid === "steps" ? t("routines.limits.stepsInvalid") : t("routines.limits.stepsHint", { count: DEFAULT_ROUTINE_STEPS })}
						</p>
					</Field>
					<Field>
						<FieldLabel className="text-xs text-muted-foreground" htmlFor="routine-limit-cost">{t("routines.limits.costLabel")}</FieldLabel>
						<Input
							aria-invalid={invalid === "cost" || undefined}
							id="routine-limit-cost"
							inputMode="decimal"
							onChange={(event) => setDraft((current) => ({ ...current, cost: event.target.value }))}
							value={draft.cost}
						/>
						<p className={invalid === "cost" ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={invalid === "cost" ? "alert" : undefined}>
							{invalid === "cost" ? t("routines.limits.costInvalid") : t("routines.limits.costHint")}
						</p>
					</Field>
					{error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button disabled={status === "saving"} size="sm" type="submit">
							{t("routines.limits.save")}
						</Button>
						{limits ? (
							<Button disabled={status === "saving"} onClick={() => void save(null)} size="sm" type="button" variant="secondary">
								{t("routines.limits.reset")}
							</Button>
						) : null}
						{status === "saved" ? <span className="text-xs text-success" role="status">{t("routines.limits.saved")}</span> : null}
					</div>
				</form>
			</CollapsibleContent>
		</Collapsible>
	);
}
