"use client";

import { ArrowLeftIcon, CopyIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import type { BuiltinSkillView } from "@/lib/atlas-api";
import { BUILTIN_GROUP_TITLE } from "../../skills-state";
import { SkillMarkdownPreview } from "./skill-markdown-preview";

/** Skill de fábrica aberta: só leitura, com o Markdown renderizado e a ação de duplicar. */
export function BuiltinSkillDetail({
	skill,
	duplicating = false,
	error,
	onBack,
	onDuplicate,
}: {
	skill: BuiltinSkillView;
	duplicating?: boolean;
	error?: string | null;
	onBack: () => void;
	onDuplicate: () => void;
}) {
	return (
		<div className="flex flex-col gap-4" data-slot="builtin-skill-detail">
			<div className="flex items-center gap-2">
				<Button aria-label="Voltar para a lista de habilidades" onClick={onBack} size="icon-sm" type="button" variant="ghost">
					<ArrowLeftIcon aria-hidden />
				</Button>
				<h3 className="min-w-0 truncate text-sm font-medium">{skill.name}</h3>
				<Badge variant="secondary">{BUILTIN_GROUP_TITLE}</Badge>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="font-mono text-xs text-muted-foreground">{skill.slug}</p>
				<Button disabled={duplicating} onClick={onDuplicate} size="sm" variant="outline">
					<CopyIcon aria-hidden data-icon="inline-start" />
					Duplicar para editar
				</Button>
			</div>
			{error ? (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			) : null}
			<div className="rounded-lg border border-border/60 p-4">
				<SkillMarkdownPreview markdown={skill.body} />
			</div>
		</div>
	);
}
