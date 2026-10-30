"use client";

import { EyeIcon, ListIcon, PencilIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { ChatCard, ChatCardHeader, ChatCardLine } from "@workspace/ui/components/chat-card";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

export type SkillActivityAction = "created" | "updated" | "deleted" | "shown" | "listed" | "cleaned";

/** "Habilidade “Resumo semanal” criada": sem chave interna e sem número de versão (linguagem com o usuário, regra 70). */
export function skillActivityText(action: SkillActivityAction, title?: string, detail?: string, { t }: Translator = defaultTranslator): string {
	const name = title ? t("aiElements.skills.activity.named", { title }) : t("aiElements.skills.activity.unnamed");
	switch (action) {
		case "created":
			return t("aiElements.skills.activity.created", { name });
		case "updated":
			return t("aiElements.skills.activity.updated", { name });
		case "deleted":
			return t("aiElements.skills.activity.deleted", { name });
		case "shown":
			return title ?? t("aiElements.skills.activity.shown");
		case "listed":
			return title ?? t("aiElements.skills.activity.listed");
		case "cleaned":
			return detail ?? t("aiElements.skills.activity.cleaned");
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
	const translator = useTranslations();
	if ((action as string) === "creating") return null;

	const main = skillActivityText(action, title, detail, translator);
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
