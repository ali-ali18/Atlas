"use client";

import { GitPullRequestIcon, ImageIcon, PaperclipIcon, PlusIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { DEV_APPROVAL_MODES, type DevApprovalMode } from "@workspace/shared";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { InputGroupButton } from "@workspace/ui/components/input-group";

import { useAddMenuSkills, type AddMenuSkill } from "./chat-add-menu";
import { permissionHelp, permissionLabel, permissionOptionLabel } from "./permission-copy";
import { useT } from "@/lib/i18n/provider";
import { defaultTranslator, type TFunction } from "@/lib/i18n/translator";

export type AddDropdownProps = {
	onPickPhotos: () => void;
	onPickFile?: () => void;
	showTestPr: boolean;
	onTestPr: () => void;
	onPickSkill: (skill: AddMenuSkill) => void;
	permission?: { mode: DevApprovalMode; onChange: (mode: DevApprovalMode) => void };
	/** Teste/pré-visualização: abre já aberto. */
	defaultOpen?: boolean;
};

/** Linhas do dropdown na ordem (puro; as mesmas condições da gaveta). Sem título nem tiles. */
export function addDropdownRows(props: Pick<AddDropdownProps, "onPickFile" | "showTestPr" | "permission">, t: TFunction = defaultTranslator.t): string[] {
	const rows = [t("composer.photos")];
	if (props.onPickFile) rows.push(t("composer.file"));
	if (props.showTestPr) rows.push(t("composer.testPr"));
	rows.push(t("composer.skill"));
	if (props.permission) rows.push(t("composer.permissionValue", { mode: permissionLabel(t, props.permission.mode) }));
	return rows;
}

/** Itens do menu compacto do "+" no desktop (sem o cabeçalho "Adicionar" nem os tiles grandes da gaveta). */
export function AddDropdownItems({ skills, skillsLoading, ...props }: Omit<AddDropdownProps, "defaultOpen"> & { skills: AddMenuSkill[]; skillsLoading: boolean }) {
	const t = useT();
	const mine = skills.filter((s) => !s.factory);
	const factory = skills.filter((s) => s.factory);
	const group = (title: string, items: AddMenuSkill[]) =>
		items.length ? (
			<DropdownMenuGroup data-add-skill-group={title}>
				<DropdownMenuLabel>{title}</DropdownMenuLabel>
				{items.map((skill) => (
					<DropdownMenuItem key={skill.id} onClick={() => props.onPickSkill(skill)} title={skill.description}>
						<SparklesIcon aria-hidden className="text-muted-foreground" />
						<span className="min-w-0 flex-1 truncate">{skill.name}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>
		) : null;
	return (
		<>
			<DropdownMenuItem onClick={props.onPickPhotos}>
				<ImageIcon aria-hidden className="text-muted-foreground" />
				{t("composer.photos")}
			</DropdownMenuItem>
			{props.onPickFile ? (
				<DropdownMenuItem onClick={props.onPickFile}>
					<PaperclipIcon aria-hidden className="text-muted-foreground" />
					{t("composer.file")}
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSeparator />
			{props.showTestPr ? (
				<DropdownMenuItem data-testid="test-pr-item" onClick={props.onTestPr}>
					<GitPullRequestIcon aria-hidden className="text-muted-foreground" />
					{t("composer.testPr")}
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<SparklesIcon aria-hidden className="text-muted-foreground" />
					{t("composer.skill")}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-72 w-64">
					{skillsLoading ? <p className="px-3 py-2 text-muted-foreground text-sm">{t("common.loading")}</p> : null}
					{!skillsLoading && skills.length === 0 ? <p className="px-3 py-2 text-muted-foreground text-sm">{t("composer.noSkills")}</p> : null}
					{group(t("composer.mySkills"), mine)}
					{group(t("composer.factorySkills"), factory)}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			{props.permission ? (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<ShieldCheckIcon aria-hidden className="text-muted-foreground" />
						{t("composer.permission")}
						<span className="ml-auto max-w-[8rem] truncate pr-1 font-normal text-muted-foreground text-xs">{permissionLabel(t, props.permission.mode)}</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-72">
						<DropdownMenuRadioGroup onValueChange={(value) => props.permission?.onChange(value as DevApprovalMode)} value={props.permission.mode}>
							{DEV_APPROVAL_MODES.map((value) => (
								<DropdownMenuRadioItem className="items-start" key={value} value={value}>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span>{permissionOptionLabel(t, value)}</span>
										<span className="whitespace-normal font-normal text-muted-foreground text-xs leading-4">{permissionHelp(t, value)}</span>
									</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			) : null}
		</>
	);
}

/** "+" do composer no desktop: dropdown compacto (teclado: setas, Enter, Esc) com as mesmas ações da gaveta. */
export function ChatAddDropdown({ defaultOpen = false, ...props }: AddDropdownProps) {
	const t = useT();
	const [open, setOpen] = useState(defaultOpen);
	const { skills, loading } = useAddMenuSkills(open);
	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger render={<InputGroupButton aria-label={t("composer.add")} size="icon-sm" type="button" variant="secondary" />}>
				<PlusIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-60" data-add-dropdown side="top" sideOffset={10}>
				<AddDropdownItems {...props} skills={skills} skillsLoading={loading} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
