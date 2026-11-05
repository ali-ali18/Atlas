import * as React from "react";
import { ChartColumnIcon, ClockIcon, CodeIcon, CompactIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, ImagesIcon, KeyRoundIcon, LayoutDashboardIcon, ListChecksIcon, ListTodoIcon, PresentationIcon, ShieldCheckIcon, SparklesIcon, UserCogIcon, UserPlusIcon, UsersIcon } from "@/components/icons";
import type { CardIconKey } from "@/lib/card-preview";

type IconComponent = (props: { size?: number; tone?: "muted-foreground" }) => React.JSX.Element;

/** Ícone de cada tipo de card na prévia da conversa. */
const ICONS: Record<CardIconKey, IconComponent> = {
	chart: ChartColumnIcon,
	panel: LayoutDashboardIcon,
	document: FileTextIcon,
	spreadsheet: FileSpreadsheetIcon,
	presentation: PresentationIcon,
	images: ImagesIcon,
	routine: ClockIcon,
	tasks: ListChecksIcon,
	questionnaire: ListTodoIcon,
	subagents: UsersIcon,
	login: KeyRoundIcon,
	approval: ShieldCheckIcon,
	skill: SparklesIcon,
	code: CodeIcon,
	compaction: CompactIcon,
	agent: UserPlusIcon,
	profile: UserCogIcon,
	generic: FileIcon,
};

/** Ícone do tipo do card, sempre na cor muted, do tamanho do texto da prévia. */
export function CardPreviewIcon({ card, size = 16 }: { card: CardIconKey; size?: number }) {
	const Icon = ICONS[card] ?? FileIcon;
	return <Icon size={size} tone="muted-foreground" />;
}
