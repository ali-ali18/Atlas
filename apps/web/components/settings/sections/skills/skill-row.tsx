"use client";

import { DownloadIcon, PencilIcon, SparklesIcon, StoreIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Switch } from "@workspace/ui/components/switch";
import type { SkillDocView } from "@/lib/atlas-api";
import {
	type BotRef,
	formatSkillDate,
	originLabel,
	draftSwitchHint,
	scopeLabel,
	statusLabel,
} from "../../skills-state";
import { useTranslations } from "@/lib/i18n/provider";

export type SkillRowActions = {
	onEdit: (skill: SkillDocView) => void;
	onToggle: (skill: SkillDocView, enabled: boolean) => void;
	onExport: (skill: SkillDocView) => void;
	onDelete: (skill: SkillDocView) => void;
	/** "Publicar no marketplace" (abre o PR no catálogo). */
	onPublish?: (skill: SkillDocView) => void;
};

/**
 * Linha compacta no estilo do modal: ícone + nome + selos e a descrição em uma
 * linha à esquerda, legenda de origem/data sob ela, ações à direita.
 */
export function SkillRow({
	skill,
	bots,
	onEdit,
	onToggle,
	onExport,
	onDelete,
	onPublish,
}: { skill: SkillDocView; bots: readonly BotRef[] } & SkillRowActions) {
	const translator = useTranslations();
	const { t } = translator;
	const draft = skill.status === "draft";
	return (
		<li
			className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
			data-slot="skill-row"
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-center gap-2">
					<SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
					<button
						className="min-w-0 truncate rounded-sm text-left font-mono text-sm leading-snug font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
						onClick={() => onEdit(skill)}
						type="button"
					>
						{skill.name}
					</button>
					<Badge variant="outline">{scopeLabel(skill, bots, translator)}</Badge>
					<Badge variant={draft ? "secondary" : "default"}>{statusLabel(skill, translator)}</Badge>
				</div>
				<p className="truncate text-sm leading-snug text-muted-foreground" title={skill.description}>
					{skill.description}
				</p>
				<p className="text-xs text-muted-foreground">
					{skill.source
						? t(skill.source.edited ? "settings.skills.fromMarketplaceEdited" : "settings.skills.fromMarketplace", { version: skill.source.version })
						: originLabel(skill.createdBy, translator)}{" "}
					· {t("settings.skills.updatedAt", { date: formatSkillDate(skill.updatedAt, undefined, translator) })}
					{draft ? ` · ${draftSwitchHint(translator)}` : ""}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1 sm:ml-auto" data-slot="skill-row-actions">
				<Button aria-label={t("settings.skills.editAria", { name: skill.name })} onClick={() => onEdit(skill)} size="icon-sm" variant="ghost">
					<PencilIcon aria-hidden />
				</Button>
				{onPublish && !draft ? (
					<Button aria-label={t("settings.skills.publishAria", { name: skill.name })} onClick={() => onPublish(skill)} size="icon-sm" title={t("settings.skills.publishTitle")} variant="ghost">
						<StoreIcon aria-hidden />
					</Button>
				) : null}
				<Button aria-label={t("settings.skills.exportAria", { name: skill.name })} onClick={() => onExport(skill)} size="icon-sm" variant="ghost">
					<DownloadIcon aria-hidden />
				</Button>
				<Button aria-label={t("settings.skills.deleteAria", { name: skill.name })} onClick={() => onDelete(skill)} size="icon-sm" variant="ghost">
					<Trash2Icon aria-hidden />
				</Button>
				<Switch
					aria-label={t(skill.enabled ? "settings.skills.disableAria" : "settings.skills.enableAria", { name: skill.name })}
					checked={skill.enabled}
					className="ml-2"
					onCheckedChange={(checked) => onToggle(skill, checked)}
					title={draft ? draftSwitchHint(translator) : undefined}
				/>
			</div>
		</li>
	);
}
