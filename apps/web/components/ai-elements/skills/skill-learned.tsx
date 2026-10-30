"use client";

import { SparklesIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/**
 * Linha discreta quando o agente grava uma skill sozinho ("Aprendi: ..."), no mesmo padrão de "Memória
 * atualizada": só o aviso, sem ação (autonomia do bot). Ajustes ficam na lista de skills.
 */
export type SkillLearnedCardProps = {
	action: "created" | "updated";
	name: string;
};

export function learnedTitle(action: "created" | "updated", name: string, { t }: Translator = defaultTranslator): string {
	return action === "created" ? t("aiElements.skills.learned.created", { name }) : t("aiElements.skills.learned.updated", { name });
}

export function SkillLearnedCard({ action, name }: SkillLearnedCardProps) {
	const translator = useTranslations();
	return (
		<Marker className="my-1 justify-center text-xs" data-testid="skill-learned">
			<MarkerIcon>
				<SparklesIcon />
			</MarkerIcon>
			<MarkerContent className="min-w-0 truncate">{learnedTitle(action, name, translator)}</MarkerContent>
		</Marker>
	);
}
