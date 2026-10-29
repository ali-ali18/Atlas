"use client";

import { PowerIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";

import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/** Texto do botão conforme o estado: o login fica salvo, então desligar não é perda. */
export function stopComputerLabel(busy: boolean, { t }: Translator = defaultTranslator): string {
	return busy ? t("contextPanel.stop.busy") : t("contextPanel.stop.label");
}

/**
 * "Desligar computador" na aba Computador. Para a VM com graça (o Chrome fecha
 * direito e o login do bot fica guardado); ligar de novo é o "Acordar".
 */
export function StopComputerButton({
	agentName,
	busy = false,
	error = null,
	onStop,
}: {
	agentName: string;
	busy?: boolean;
	error?: string | null;
	onStop: () => void;
}) {
	const translator = useTranslations();
	return (
		<div className="flex flex-col items-center gap-1">
			<Button
				aria-label={translator.t("contextPanel.stop.aria", { name: agentName })}
				disabled={busy}
				onClick={onStop}
				size="xs"
				type="button"
				variant="ghost"
			>
				<PowerIcon aria-hidden="true" />
				{stopComputerLabel(busy, translator)}
			</Button>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
