"use client";

import { EyeIcon, ListIcon, PencilIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { ChatCard, ChatCardHeader, ChatCardLine } from "@workspace/ui/components/chat-card";

export type SkillActivityAction = "created" | "updated" | "deleted" | "shown" | "listed" | "cleaned";

/** "Habilidade “Resumo semanal” criada": sem chave interna e sem número de versão (linguagem com o usuário, regra 70). */
export function skillActivityText(action: SkillActivityAction, title?: string, detail?: string): string {
	const name = title ? `Habilidade “${title}”` : "Habilidade";
	switch (action) {
		case "created":
			return `${name} criada e ativa`;
		case "updated":
			return `${name} atualizada`;
		case "deleted":
			return `${name} apagada`;
		case "shown":
			return title ?? "Habilidade exibida";
		case "listed":
			return title ?? "Habilidades listadas";
		case "cleaned":
			return detail ?? "Rascunhos apagados";
	}
}

export function SkillActivityCard({
	action,
	title,
	detail,
}: {
	action: SkillActivityAction;
	title?: string;
	/** Aceitos por compatibilidade com o evento; não aparecem para o usuário. */
	capabilityKey?: string;
	versionNumber?: number;
	agentName?: string;
	detail?: string;
}) {
	if ((action as string) === "creating") return null;

	const main = skillActivityText(action, title, detail);
	const Icon =
		action === "created"
			? SparklesIcon
			: action === "updated"
				? PencilIcon
				: action === "deleted" || action === "cleaned"
					? Trash2Icon
					: action === "shown"
						? EyeIcon
						: ListIcon;

	if ((action === "shown" || action === "created" || action === "updated") && detail) {
		return (
			<ChatCard className="self-start">
				<ChatCardHeader leading={<Icon />} title={<span className="min-w-0 [overflow-wrap:anywhere]">{main}</span>} />
				<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-sans text-foreground text-sm leading-relaxed">{detail}</pre>
			</ChatCard>
		);
	}

	return (
		<ChatCard variant="activity" className="self-start text-xs">
			<ChatCardLine leading={<Icon />}>
				<span className="font-medium text-foreground">{main}</span>
			</ChatCardLine>
		</ChatCard>
	);
}
