"use client";

import { BanIcon, CheckIcon, ChevronDownIcon, CircleCheckIcon, HandIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import {
	TOOL_PERMISSION_ORDER,
	toolPermissionLabel,
	type ToolPermission,
	type ToolPermissionValue,
} from "./tool-permissions";

export const TOOL_PERMISSION_ICONS: Record<ToolPermission, ComponentType<{ className?: string }>> = {
	never_ask: CircleCheckIcon,
	always_ask: HandIcon,
	blocked: BanIcon,
};

/** Largura fixa do controle: linhas alinhadas em qualquer estado. */
export const PERMISSION_TRIGGER_CLASS = "w-44 justify-between md:hidden";

export function permissionValueLabel(value: ToolPermissionValue, translator: Translator = defaultTranslator): string {
	return value === "mixed" ? translator.t("marketplace.perm.mixed") : toolPermissionLabel(value, translator);
}

/**
 * Três estados por tool. Desktop (md+): grupo de botões só com ícone; mobile:
 * gatilho com o estado atual abrindo um menu.
 */
export function ToolPermissionControl({
	value,
	onChange,
	disabled,
	name,
}: {
	value: ToolPermissionValue;
	onChange: (mode: ToolPermission) => void;
	disabled?: boolean;
	/** Sobre o que é o controle, para leitores de tela. */
	name: string;
}) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<div className="flex shrink-0 items-center" data-tool-permission>
			<ButtonGroup aria-label={t("marketplace.perm.of", { name })} className="hidden md:flex">
				{TOOL_PERMISSION_ORDER.map((mode) => {
					const Icon = TOOL_PERMISSION_ICONS[mode];
					const selected = value === mode;
					return (
						<Tooltip key={mode}>
							<TooltipTrigger
								render={
									<Button
										aria-label={toolPermissionLabel(mode, translator)}
										aria-pressed={selected}
										disabled={disabled}
										onClick={() => {
											if (!selected) onChange(mode);
										}}
										size="icon-sm"
										type="button"
										variant={selected ? "secondary" : "outline"}
									/>
								}
							>
								<Icon className={selected ? "text-foreground" : "text-muted-foreground"} />
							</TooltipTrigger>
							<TooltipContent className="px-2 py-1 text-caption">{toolPermissionLabel(mode, translator)}</TooltipContent>
						</Tooltip>
					);
				})}
			</ButtonGroup>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={t("marketplace.perm.ofCurrent", { name, value: permissionValueLabel(value, translator) })}
							className={PERMISSION_TRIGGER_CLASS}
							disabled={disabled}
							size="sm"
							type="button"
							variant="outline"
						/>
					}
				>
					<span className="truncate">{permissionValueLabel(value, translator)}</span>
					<ChevronDownIcon className="text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{TOOL_PERMISSION_ORDER.map((mode) => {
						const Icon = TOOL_PERMISSION_ICONS[mode];
						return (
							<DropdownMenuItem key={mode} onClick={() => onChange(mode)}>
								<Icon />
								<span className="flex-1">{toolPermissionLabel(mode, translator)}</span>
								{value === mode ? <CheckIcon aria-label={t("marketplace.perm.current")} /> : null}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
