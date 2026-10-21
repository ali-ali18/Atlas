"use client";

import {
	EyeIcon,
	ListIcon,
	PencilIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";

export type SkillActivityAction =
	| "created"
	| "updated"
	| "deleted"
	| "shown"
	| "listed"
	| "cleaned";

export function SkillActivityCard({
	action,
	title,
	capabilityKey,
	versionNumber,
	agentName,
	detail,
}: {
	action: SkillActivityAction;
	title?: string;
	capabilityKey?: string;
	versionNumber?: number;
	agentName?: string;
	detail?: string;
}) {
	if ((action as string) === "creating") return null;

	const versionSuffix =
		versionNumber !== undefined && versionNumber !== null
			? ` (v${versionNumber})`
			: "";
	const capabilityLine = capabilityKey
		? `${capabilityKey}${versionSuffix}`
		: null;

	let main: string;
	switch (action) {
		case "created":
			main = title ? `${title} criada e ativa` : "Skill criada e ativa";
			break;
		case "updated":
			main = title
				? `${title} atualizada${versionSuffix}`
				: capabilityKey
					? `Skill ${capabilityKey} atualizada${versionSuffix}`
					: "Skill atualizada";
			break;
		case "deleted":
			main = capabilityKey ? `${capabilityKey} apagada` : "Skill apagada";
			break;
		case "shown":
			main = title ?? "Skill exibida";
			break;
		case "listed":
			main = title ?? "Skills listadas";
			break;
		case "cleaned":
			main = detail ?? "Rascunhos apagados";
			break;
	}

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
			<div className="flex w-full min-w-0 max-w-xl flex-col gap-2 self-start rounded-2xl border bg-card px-3 py-3 text-xs">
				<div className="flex items-center gap-2">
					<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
						<Icon className="size-3" />
					</span>
					<span className="min-w-0 [overflow-wrap:anywhere]">
						<span className="block font-medium text-foreground">{main}</span>
						{capabilityLine ? (
							<span className="block text-muted-foreground">{capabilityLine}</span>
						) : null}
					</span>
				</div>
				<pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-sans text-foreground text-xs leading-relaxed">
					{detail}
				</pre>
			</div>
		);
	}

	return (
		<div className="flex max-w-full min-w-0 items-center gap-2 self-start rounded-2xl border bg-card px-3 py-2 text-xs">
			<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-3" />
			</span>
			<span className="min-w-0 [overflow-wrap:anywhere]">
				<span className="block font-medium text-foreground">{main}</span>
				{capabilityLine ? (
					<span className="block text-muted-foreground">{capabilityLine}</span>
				) : null}
			</span>
		</div>
	);
}
