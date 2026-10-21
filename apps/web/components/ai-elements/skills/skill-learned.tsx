"use client";

import { useState } from "react";
import { SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";

/**
 * Aviso de skill que o agente gravou sozinho ("Aprendi: ..."). O dono não precisa aprovar, mas pode desfazer:
 * a skill criada é apagada e a atualizada volta ao texto anterior (a API confere que ninguém mexeu depois).
 */
export type SkillLearnedCardProps = {
	action: "created" | "updated";
	name: string;
	/** Resumo curto (a descrição da skill). */
	summary?: string;
	/** Já desfeito (estado vindo do histórico da conversa). */
	undone?: boolean;
	/** Sem handler, o botão não aparece (ex.: conversa sem dono carregado). Rejeitar = erro mostrado no card. */
	onUndo?: () => Promise<void>;
};

export function learnedTitle(action: "created" | "updated", name: string): string {
	return action === "created" ? `Aprendi: ${name}` : `Atualizei a skill ${name}`;
}

export function undoErrorMessage(error: unknown): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	const message = error instanceof Error ? error.message.trim() : "";
	if (status === 404) return "Essa skill não existe mais.";
	if (status === 409) return message || "A skill mudou depois do aviso; ajuste pela lista de skills.";
	return "Não foi possível desfazer. Tente de novo.";
}

export function SkillLearnedCard({ action, name, summary, undone = false, onUndo }: SkillLearnedCardProps) {
	const [state, setState] = useState<"idle" | "working" | "undone">(undone ? "undone" : "idle");
	const [error, setError] = useState<string | null>(null);

	async function undo() {
		if (!onUndo || state !== "idle") return;
		setState("working");
		setError(null);
		try {
			await onUndo();
			setState("undone");
		} catch (cause) {
			setError(undoErrorMessage(cause));
			setState("idle");
		}
	}

	return (
		<div className="flex w-full min-w-0 max-w-xl flex-col gap-2 self-start rounded-2xl border bg-card px-3 py-3 text-xs" data-testid="skill-learned">
			<div className="flex items-start gap-2">
				<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
					<SparklesIcon className="size-3" />
				</span>
				<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
					<span className="block font-medium text-foreground">{learnedTitle(action, name)}</span>
					{summary ? <span className="block text-muted-foreground">{summary}</span> : null}
					{state === "undone" ? <span className="mt-1 block text-muted-foreground">Desfeito.</span> : null}
					{error ? (
						<span className="mt-1 block text-destructive" role="alert">
							{error}
						</span>
					) : null}
				</span>
				{onUndo && state !== "undone" ? (
					<Button aria-label={`Desfazer: ${learnedTitle(action, name)}`} disabled={state === "working"} onClick={() => void undo()} size="xs" type="button" variant="outline">
						<Undo2Icon data-icon="inline-start" />
						Desfazer
					</Button>
				) : null}
			</div>
		</div>
	);
}
