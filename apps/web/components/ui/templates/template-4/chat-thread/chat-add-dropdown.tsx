"use client";

import { GitPullRequestIcon, ImageIcon, PaperclipIcon, PlusIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { DEV_APPROVAL_MODES, DEV_APPROVAL_MODE_HELP, DEV_APPROVAL_MODE_LABEL, type DevApprovalMode } from "@workspace/shared";
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
export function addDropdownRows(props: Pick<AddDropdownProps, "onPickFile" | "showTestPr" | "permission">): string[] {
	const rows = ["Fotos"];
	if (props.onPickFile) rows.push("Arquivo");
	if (props.showTestPr) rows.push("Testar uma PR");
	rows.push("Skill");
	if (props.permission) rows.push(`Permissão: ${DEV_APPROVAL_MODE_LABEL[props.permission.mode]}`);
	return rows;
}

/** Itens do menu compacto do "+" no desktop (sem o cabeçalho "Adicionar" nem os tiles grandes da gaveta). */
export function AddDropdownItems({ skills, skillsLoading, ...props }: Omit<AddDropdownProps, "defaultOpen"> & { skills: AddMenuSkill[]; skillsLoading: boolean }) {
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
				Fotos
			</DropdownMenuItem>
			{props.onPickFile ? (
				<DropdownMenuItem onClick={props.onPickFile}>
					<PaperclipIcon aria-hidden className="text-muted-foreground" />
					Arquivo
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSeparator />
			{props.showTestPr ? (
				<DropdownMenuItem data-testid="test-pr-item" onClick={props.onTestPr}>
					<GitPullRequestIcon aria-hidden className="text-muted-foreground" />
					Testar uma PR
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<SparklesIcon aria-hidden className="text-muted-foreground" />
					Skill
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-72 w-64">
					{skillsLoading ? <p className="px-3 py-2 text-muted-foreground text-sm">Carregando…</p> : null}
					{!skillsLoading && skills.length === 0 ? <p className="px-3 py-2 text-muted-foreground text-sm">Nenhuma skill disponível.</p> : null}
					{group("Minhas skills", mine)}
					{group("De fábrica", factory)}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			{props.permission ? (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<ShieldCheckIcon aria-hidden className="text-muted-foreground" />
						Permissão
						<span className="ml-auto max-w-[8rem] truncate pr-1 font-normal text-muted-foreground text-xs">{DEV_APPROVAL_MODE_LABEL[props.permission.mode]}</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-72">
						<DropdownMenuRadioGroup onValueChange={(value) => props.permission?.onChange(value as DevApprovalMode)} value={props.permission.mode}>
							{DEV_APPROVAL_MODES.map((value) => (
								<DropdownMenuRadioItem className="items-start" key={value} value={value}>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span>{value === "auto" ? `${DEV_APPROVAL_MODE_LABEL[value]} (recomendado)` : DEV_APPROVAL_MODE_LABEL[value]}</span>
										<span className="whitespace-normal font-normal text-muted-foreground text-xs leading-4">{DEV_APPROVAL_MODE_HELP[value]}</span>
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
	const [open, setOpen] = useState(defaultOpen);
	const { skills, loading } = useAddMenuSkills(open);
	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger render={<InputGroupButton aria-label="Adicionar" size="icon-sm" type="button" variant="secondary" />}>
				<PlusIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-60" data-add-dropdown side="top" sideOffset={10}>
				<AddDropdownItems {...props} skills={skills} skillsLoading={loading} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
