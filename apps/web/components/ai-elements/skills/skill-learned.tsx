"use client";

import { SparklesIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

/**
 * Linha discreta quando o agente grava uma skill sozinho ("Aprendi: ..."), no mesmo padrão de "Memória
 * atualizada": só o aviso, sem ação (autonomia do bot). Ajustes ficam na lista de skills.
 */
export type SkillLearnedCardProps = {
	action: "created" | "updated";
	name: string;
};

export function learnedTitle(action: "created" | "updated", name: string): string {
	return action === "created" ? `Aprendi: ${name}` : `Atualizei a skill ${name}`;
}

export function SkillLearnedCard({ action, name }: SkillLearnedCardProps) {
	return (
		<Marker className="my-1 justify-center text-xs" data-testid="skill-learned">
			<MarkerIcon>
				<SparklesIcon />
			</MarkerIcon>
			<MarkerContent className="min-w-0 truncate">{learnedTitle(action, name)}</MarkerContent>
		</Marker>
	);
}
