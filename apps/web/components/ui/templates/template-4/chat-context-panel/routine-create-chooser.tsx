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
import { GithubRepoField } from "./routine-editor";

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
				<span className="flex-1">{template.label}</span>
			</button>
			{expanded ? (
				<div className="mt-2 space-y-2">
					<Field>
						<FieldLabel className="text-xs text-muted-foreground">
							Repositório
						</FieldLabel>
						<GithubRepoField onChange={setRepo} value={repo} />
					</Field>
					{needsCiBranch ? (
						<Field>
							<FieldLabel className="text-xs text-muted-foreground">
								Branch de CI
							</FieldLabel>
							<Select
								onValueChange={(value) => setCiBranch(value ?? "")}
								value={ciBranch}
							>
								<SelectTrigger>
									<SelectValue
										placeholder={loadingOptions ? "Carregando…" : "Escolha a branch"}
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
							<FieldLabel className="text-xs text-muted-foreground">PR</FieldLabel>
							<Select
								onValueChange={(value) => setPrNumber(value ?? "")}
								value={prNumber}
							>
								<SelectTrigger>
									<SelectValue
										placeholder={loadingOptions ? "Carregando…" : "Escolha o PR"}
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
						{creating ? "Criando…" : "Criar rotina"}
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
					<PopoverTitle className="text-sm">Nova rotina</PopoverTitle>
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
					Descreva no chat
				</Button>

				<div className="space-y-1.5">
					<p className="text-muted-foreground text-xs">Atalhos do GitHub</p>
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
					<p className="text-muted-foreground text-xs">Outros gatilhos</p>
					<div className="space-y-1.5">
						<ChooserRow
							icon={<ClockIcon />}
							label="Agendada"
							onClick={() => {
								setOpen(false);
								onCreateScheduled();
							}}
						/>
						<ChooserRow
							icon={<WebhookIcon />}
							label="Webhook"
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
