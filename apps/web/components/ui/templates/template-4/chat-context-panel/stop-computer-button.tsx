"use client";

import { PowerIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";

/** Texto do botão conforme o estado: o login fica salvo, então desligar não é perda. */
export function stopComputerLabel(busy: boolean): string {
	return busy ? "Desligando…" : "Desligar computador";
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
	return (
		<div className="flex flex-col items-center gap-1">
			<Button
				aria-label={`Desligar o computador de ${agentName}`}
				disabled={busy}
				onClick={onStop}
				size="xs"
				type="button"
				variant="ghost"
			>
				<PowerIcon aria-hidden="true" />
				{stopComputerLabel(busy)}
			</Button>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
