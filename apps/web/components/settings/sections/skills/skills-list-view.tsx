"use client";

import { useRef } from "react";
import { ChevronRightIcon, LockIcon, InfoIcon, PlusIcon, SearchIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { SettingsPicker } from "@/components/ui/templates/template-4/settings-picker";
import type { BuiltinSkillView, SkillDocView } from "@/lib/atlas-api";
import {
	type BotRef,
	builtinGroupHint,
	builtinGroupTitle,
	importNotice,
	SCOPE_ALL,
	builtinsVisibleForScope,
	emptyListText,
	filterBuiltins,
	filterSkills,
	partitionSkills,
	scopeFilterOptions,
} from "../../skills-state";
import { SkillRow, type SkillRowActions } from "./skill-row";
import { useTranslations } from "@/lib/i18n/provider";

export type SkillsListViewProps = SkillRowActions & {
	skills: readonly SkillDocView[];
	builtins?: readonly BuiltinSkillView[];
	onOpenBuiltin?: (skill: BuiltinSkillView) => void;
	bots: readonly BotRef[];
	loading: boolean;
	error: string | null;
	actionError?: string | null;
	query: string;
	onQueryChange: (query: string) => void;
	scope: string;
	onScopeChange: (scope: string) => void;
	draftsOpen: boolean;
	onDraftsOpenChange: (open: boolean) => void;
	/** Última importação: avisa que veio de arquivo externo e precisa de revisão. */
	notice?: SkillDocView | null;
	onDismissNotice?: () => void;
	onCreate: () => void;
	/** Abre a confirmação (com a contagem) de apagar os rascunhos do escopo atual. */
	onDeleteDrafts: () => void;
	onImportFile: (file: File) => void;
	onRetry: () => void;
};

/** Seção Habilidades (só apresentação): busca, escopo, lista e rascunhos recolhidos. */
export function SkillsListView(props: SkillsListViewProps) {
	const translator = useTranslations();
	const { t } = translator;
	const { skills, bots, query, scope, loading, error } = props;
	const fileRef = useRef<HTMLInputElement>(null);
	const filtered = filterSkills(skills, { query, scope });
	const { active, drafts } = partitionSkills(filtered);
	const builtins = builtinsVisibleForScope(scope) ? filterBuiltins(props.builtins ?? [], query) : [];
	const hasFilter = query.trim() !== "" || scope !== SCOPE_ALL;
	// Busca ativa abre os rascunhos para não esconder o que casou.
	const draftsOpen = props.draftsOpen || query.trim() !== "";
	const rowProps = {
		bots,
		onEdit: props.onEdit,
		onToggle: props.onToggle,
		onExport: props.onExport,
		onDelete: props.onDelete,
		onPublish: props.onPublish,
	};

	return (
		<div className="flex flex-col gap-5" data-slot="skills-list">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<div className="relative min-w-0 flex-1">
					<SearchIcon
						aria-hidden
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						aria-label={t("settings.skills.searchAria")}
						className="h-9 pl-9"
						onChange={(event) => props.onQueryChange(event.target.value)}
						placeholder={t("settings.skills.searchPlaceholder")}
						type="search"
						value={query}
					/>
				</div>
				<SettingsPicker
					aria-label={t("settings.skills.scopeAria")}
					className="w-full sm:w-48"
					onChange={props.onScopeChange}
					options={scopeFilterOptions(bots, translator)}
					value={scope}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<Button onClick={props.onCreate} size="sm">
					<PlusIcon aria-hidden data-icon="inline-start" />
					{t("settings.skills.new")}
				</Button>
				<Button onClick={() => fileRef.current?.click()} size="sm" variant="outline">
					<UploadIcon aria-hidden data-icon="inline-start" />
					{t("settings.skills.importMd")}
				</Button>
				<input
					accept=".md,text/markdown"
					aria-label={t("settings.skills.fileAria")}
					className="sr-only"
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) props.onImportFile(file);
					}}
					ref={fileRef}
					tabIndex={-1}
					type="file"
				/>
			</div>

			{props.notice ? (
				<Alert data-slot="skills-import-notice" role="status" variant="warning">
					<InfoIcon aria-hidden />
					<AlertTitle>{t("settings.skills.noticeTitle", { name: props.notice.name })}</AlertTitle>
					<AlertDescription>{importNotice(translator)}</AlertDescription>
					<div className="col-span-full mt-2 flex justify-end gap-2">
						<Button onClick={props.onDismissNotice} size="sm" variant="ghost">
							{t("settings.skills.dismiss")}
						</Button>
						<Button onClick={() => props.notice && props.onEdit(props.notice)} size="sm" variant="outline">
							{t("settings.skills.review")}
						</Button>
					</div>
				</Alert>
			) : null}

			{props.actionError ? (
				<p className="text-sm text-destructive" role="alert">
					{props.actionError}
				</p>
			) : null}

			{loading ? (
				<p className="text-sm text-muted-foreground" role="status">
					{t("settings.skills.loading")}
				</p>
			) : error ? (
				<div className="flex flex-col items-start gap-2">
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
					<Button onClick={props.onRetry} size="sm" variant="outline">
						{t("common.retry")}
					</Button>
				</div>
			) : (
				<>
					{builtins.length > 0 ? (
						<section aria-label={builtinGroupTitle(translator)} className="flex flex-col gap-2" data-slot="skills-builtin-group">
							<div className="flex flex-col gap-0.5">
								<h3 className="text-sm font-medium">{builtinGroupTitle(translator)}</h3>
								<p className="text-xs text-muted-foreground">{builtinGroupHint(translator)}</p>
							</div>
							<ul aria-label={t("settings.skills.builtinListAria")} className="flex w-full flex-col divide-y divide-border/60">
								{builtins.map((skill) => (
									<li className="flex flex-col gap-1 py-3 first:pt-1 last:pb-0" data-slot="builtin-skill-row" key={skill.slug}>
										<div className="flex min-w-0 items-center gap-2">
											<LockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
											<button
												className="min-w-0 truncate rounded-sm text-left font-mono text-sm leading-snug font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
												onClick={() => props.onOpenBuiltin?.(skill)}
												type="button"
											>
												{skill.slug}
											</button>
											<Badge variant="secondary">{builtinGroupTitle(translator)}</Badge>
										</div>
										<p className="truncate text-sm leading-snug text-muted-foreground" title={skill.name}>
											{skill.name}
										</p>
									</li>
								))}
							</ul>
						</section>
					) : null}

					{active.length > 0 ? (
						<ul aria-label={t("settings.skills.listAria")} className="flex w-full flex-col divide-y divide-border/60">
							{active.map((skill) => (
								<SkillRow key={skill.id} skill={skill} {...rowProps} />
							))}
						</ul>
					) : drafts.length === 0 && builtins.length === 0 ? (
						<p className="text-sm text-muted-foreground" role="status">
							{emptyListText(skills.length, hasFilter, translator)}
						</p>
					) : null}

					{drafts.length > 0 ? (
						<Collapsible onOpenChange={props.onDraftsOpenChange} open={draftsOpen}>
							<div className="flex items-center justify-between gap-2">
								<CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
									<ChevronRightIcon
										aria-hidden
										className={cn("size-4 transition-transform", draftsOpen && "rotate-90")}
									/>
									{t("settings.skills.drafts", { count: drafts.length })}
								</CollapsibleTrigger>
								{query.trim() === "" ? (
									<Button onClick={props.onDeleteDrafts} size="sm" variant="ghost">
										<Trash2Icon aria-hidden data-icon="inline-start" />
										{t("settings.skills.deleteDrafts")}
									</Button>
								) : null}
							</div>
							<CollapsibleContent>
								<p className="mt-1 mb-3 text-xs text-muted-foreground">{t("settings.skills.draftsHelp")}</p>
								<ul aria-label={t("settings.skills.draftsListAria")} className="flex w-full flex-col divide-y divide-border/60">
									{drafts.map((skill) => (
										<SkillRow key={skill.id} skill={skill} {...rowProps} />
									))}
								</ul>
							</CollapsibleContent>
						</Collapsible>
					) : null}
				</>
			)}
		</div>
	);
}
