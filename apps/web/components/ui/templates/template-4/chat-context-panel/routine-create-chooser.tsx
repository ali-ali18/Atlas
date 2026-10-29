"use client";

import { ClockIcon, SparklesIcon, WebhookIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import {
	Popover,
	PopoverContent,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@workspace/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@workspace/ui/components/select";
import { cn } from "@workspace/ui/lib/utils";
import { GITHUB_ROUTINE_TEMPLATES, type GithubRoutineTemplate } from "@workspace/shared";
import {
	listGithubBranches,
	listGithubPulls,
	type GithubBranchOption,
	type GithubPullOption,
} from "@/lib/atlas-api";
import { GithubMarkIcon } from "@/components/icons/github-mark";
import { useT } from "@/lib/i18n/provider";
import { GithubRepoField } from "./routine-editor";

/** Nome do atalho no idioma da tela (o `shared` guarda o rótulo em pt-BR). */
function templateLabel(template: GithubRoutineTemplate, t: ReturnType<typeof useT>): string {
	switch (template.id) {
		case "ci_failed":
			return t("routines.tpl.ci_failed");
		case "pr_babysit":
			return t("routines.tpl.pr_babysit");
		case "pr_activity":
			return t("routines.tpl.pr_activity");
		case "branch_watch":
			return t("routines.tpl.branch_watch");
		default:
			return template.label;
	}
}

export type TemplateCreateFields = {
	repo: string;
	ciBranch?: string;
	prNumber?: number;
};

function TemplateRow({
	template,
	onCreate,
}: {
	template: GithubRoutineTemplate;
	onCreate: (fields: TemplateCreateFields) => Promise<string | null>;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [repo, setRepo] = useState("");
	const [ciBranch, setCiBranch] = useState("");
	const [prNumber, setPrNumber] = useState("");
	const [branches, setBranches] = useState<GithubBranchOption[]>([]);
	const [pulls, setPulls] = useState<GithubPullOption[]>([]);
	const [loadingOptions, setLoadingOptions] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const needsCiBranch = template.asks.includes("ciBranch");
	const needsPrNumber = template.asks.includes("prNumber");

	useEffect(() => {
		const trimmed = repo.trim();
		if (!expanded || !trimmed || (!needsCiBranch && !needsPrNumber)) {
			setBranches([]);
			setPulls([]);
			return;
		}
		let cancelled = false;
		setLoadingOptions(true);
		Promise.all([
			needsCiBranch ? listGithubBranches(trimmed) : Promise.resolve([]),
			needsPrNumber ? listGithubPulls(trimmed) : Promise.resolve([]),
		])
			.then(([branchOptions, pullOptions]) => {
				if (cancelled) return;
				setBranches(branchOptions);
				setPulls(pullOptions);
			})
			.catch(() => {
				if (cancelled) return;
				setBranches([]);
				setPulls([]);
			})
			.finally(() => {
				if (!cancelled) setLoadingOptions(false);
			});
		return () => {
			cancelled = true;
		};
	}, [expanded, repo, needsCiBranch, needsPrNumber]);

	const canCreate =
		repo.trim().length > 0 &&
		(!needsCiBranch || ciBranch.trim().length > 0) &&
		(!needsPrNumber || prNumber.trim().length > 0);

	async function handleCreate() {
		setCreating(true);
		setError(null);
		try {
			const result = await onCreate({
				repo: repo.trim(),
				ciBranch: needsCiBranch ? ciBranch.trim() || undefined : undefined,
				prNumber:
					needsPrNumber && prNumber.trim()
						? Number.parseInt(prNumber, 10)
						: undefined,
			});
			if (result) setError(result);
		} finally {
			setCreating(false);
		}
	}

	return (
		<div className="rounded-xl border p-2">
			<button
				className="flex w-full items-center gap-2 text-left text-sm"
				onClick={() => setExpanded((value) => !value)}
				type="button"
			>
				<GithubMarkIcon className="size-4 shrink-0 text-muted-foreground" />
				<span className="flex-1">{templateLabel(template, t)}</span>
			</button>
			{expanded ? (
				<div className="mt-2 space-y-2">
					<Field>
						<FieldLabel className="text-xs text-muted-foreground">
							{t("routines.chooser.repo")}
						</FieldLabel>
						<GithubRepoField onChange={setRepo} value={repo} />
					</Field>
					{needsCiBranch ? (
						<Field>
							<FieldLabel className="text-xs text-muted-foreground">
								{t("routines.chooser.ciBranch")}
							</FieldLabel>
							<Select
								onValueChange={(value) => setCiBranch(value ?? "")}
								value={ciBranch}
							>
								<SelectTrigger>
									<SelectValue
										placeholder={loadingOptions ? t("common.loading") : t("routines.chooser.chooseBranch")}
									/>
								</SelectTrigger>
								<SelectContent>
									{branches.map((branch) => (
										<SelectItem key={branch.name} value={branch.name}>
											{branch.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					) : null}
					{needsPrNumber ? (
						<Field>
							<FieldLabel className="text-xs text-muted-foreground">{t("routines.chooser.pr")}</FieldLabel>
							<Select
								onValueChange={(value) => setPrNumber(value ?? "")}
								value={prNumber}
							>
								<SelectTrigger>
									<SelectValue
										placeholder={loadingOptions ? t("common.loading") : t("routines.chooser.choosePr")}
									/>
								</SelectTrigger>
								<SelectContent>
									{pulls.map((pr) => (
										<SelectItem key={pr.number} value={String(pr.number)}>
											#{pr.number} {pr.title}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					) : null}
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<Button
						disabled={!canCreate || creating}
						onClick={() => void handleCreate()}
						size="sm"
					>
						{creating ? t("routines.chooser.creating") : t("routines.section.create")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function ChooserRow({
	icon,
	label,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className="flex w-full items-center gap-2 rounded-xl border p-2 text-left text-sm transition-colors hover:bg-muted/50"
			onClick={onClick}
			type="button"
		>
			<span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
			<span className="flex-1">{label}</span>
		</button>
	);
}

export function RoutineCreateChooser({
	className,
	onCreateScheduled,
	onCreateTemplate,
	onCreateWebhook,
	onDescribeInChat,
	trigger,
}: {
	className?: string;
	onCreateScheduled: () => void;
	onCreateTemplate: (
		template: GithubRoutineTemplate,
		fields: TemplateCreateFields,
	) => Promise<string | null>;
	onCreateWebhook: () => void;
	onDescribeInChat: () => void;
	trigger: ReactElement;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger render={trigger} />
			<PopoverContent
				align="end"
				className={cn("w-80 gap-3", className)}
				side="bottom"
			>
				<PopoverHeader>
					<PopoverTitle className="text-sm">{t("routines.chooser.title")}</PopoverTitle>
				</PopoverHeader>

				<Button
					className="justify-start gap-2"
					onClick={() => {
						setOpen(false);
						onDescribeInChat();
					}}
					size="sm"
				>
					<SparklesIcon className="size-4" />
					{t("routines.chooser.describe")}
				</Button>

				<div className="space-y-1.5">
					<p className="text-muted-foreground text-xs">{t("routines.chooser.shortcuts")}</p>
					<div className="space-y-1.5">
						{GITHUB_ROUTINE_TEMPLATES.map((template) => (
							<TemplateRow
								key={template.id}
								onCreate={async (fields) => {
									const error = await onCreateTemplate(template, fields);
									if (!error) setOpen(false);
									return error;
								}}
								template={template}
							/>
						))}
					</div>
				</div>

				<div className="space-y-1.5">
					<p className="text-muted-foreground text-xs">{t("routines.chooser.other")}</p>
					<div className="space-y-1.5">
						<ChooserRow
							icon={<ClockIcon />}
							label={t("routines.chooser.scheduled")}
							onClick={() => {
								setOpen(false);
								onCreateScheduled();
							}}
						/>
						<ChooserRow
							icon={<WebhookIcon />}
							label={t("routines.chooser.webhook")}
							onClick={() => {
								setOpen(false);
								onCreateWebhook();
							}}
						/>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
