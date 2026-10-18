"use client";

import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { normalizeShape, resolveShape } from "@workspace/ui/lib/avatar/identity";
import { SHAPE_IDS } from "@workspace/ui/lib/avatar/geometry/shapes";
import { Button } from "@workspace/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { bodyColors } from "../data";
import { usePreviewExpression } from "../use-preview-expression";
import { AgentAvatar } from "../agent-avatar";

const TABS = ["Bot", "Gerar", "Enviar"] as const;

// Ordem do menu: as formas mais simples primeiro (a ordem do catálogo do motor).
const SHAPE_ORDER = SHAPE_IDS;

export function AvatarEditor({
	botId,
	color,
	onColorChange,
	onReset,
	onShapeChange,
	shape,
}: {
	/** Id do bot: sem forma escolhida, a forma e o ritmo saem dele. */
	botId?: string;
	color: string;
	onColorChange: (color: string) => void;
	onReset: () => void;
	onShapeChange?: (shape: string) => void;
	/** Forma do bot; aceita as antigas ("rond", "goutte"...). Sem valor, sai do id. */
	shape?: string;
}) {
	const [tab, setTab] = useState<(typeof TABS)[number]>("Bot");
	const selectedShape = normalizeShape(shape) ?? (botId ? resolveShape(undefined, botId) : undefined);
	const { expression, surpriseOnHover, releaseHover, surpriseOnTap } = usePreviewExpression();

	return (
		<Tooltip>
			<DropdownMenu>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="Editar avatar"
									className="group/avatar relative size-20 rounded-2xl p-0 hover:bg-sidebar-accent/40 dark:hover:bg-sidebar-accent/40"
									onPointerEnter={surpriseOnHover}
									onPointerLeave={releaseHover}
									onClick={surpriseOnTap}
									variant="ghost"
								>
									<AgentAvatar
										bodyColor={color}
										id={botId}
										mood={expression}
										shape={shape}
										size={64}
									/>
									<span className="pointer-events-none absolute inset-0 z-10 grid place-items-center opacity-0 transition-opacity group-hover/avatar:opacity-100">
										<span className="relative size-5">
											<PencilIcon className="absolute inset-0 size-5 text-black/40 [stroke-width:4]" />
											<PencilIcon className="absolute inset-0 size-5 text-white" />
										</span>
									</span>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent className="px-2 py-1 text-[11px]">
					Editar avatar
				</TooltipContent>
				<DropdownMenuContent align="center" className="w-72">
					<div className="flex items-center justify-between gap-2 px-1 py-1">
						<div className="flex items-center gap-0.5">
							{TABS.map((item) => (
								<button
									className={cn(
										"rounded-lg px-2 py-1 text-xs transition-colors",
										tab === item
											? "bg-muted font-medium text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
									key={item}
									onClick={() => setTab(item)}
									type="button"
								>
									{item}
								</button>
							))}
						</div>
						<button
							className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
							onClick={onReset}
							type="button"
						>
							Redefinir
						</button>
					</div>
					<DropdownMenuSeparator />
					<div className="flex flex-col gap-3 p-2">
						{tab === "Bot" ? (
							<>
								<div
									aria-label="Formato do avatar"
									className="grid grid-cols-5 gap-1.5"
									role="radiogroup"
								>
									{SHAPE_ORDER.map(
										(item) => (
											<button
												aria-checked={selectedShape === item}
												aria-label={`Forma ${item}`}
												className={cn(
													"grid size-12 place-items-center rounded-2xl transition-colors hover:bg-muted",
													selectedShape === item && "bg-muted",
												)}
												key={item}
												onClick={() => onShapeChange?.(item)}
												role="radio"
												type="button"
											>
												<AgentAvatar
													animated={false}
													bodyColor={color}
													id={item}
													shape={item}
													size={36}
												/>
											</button>
										),
									)}
								</div>
								<DropdownMenuSeparator />
								<div className="grid grid-cols-6 gap-2">
									{bodyColors.map((option) => (
										<button
											aria-label={option.name}
											aria-pressed={color === option.value}
											className={cn(
												"size-7 rounded-full border border-border ring-offset-2 ring-offset-popover transition",
												color === option.value && "ring-2 ring-ring",
											)}
											key={option.value}
											onClick={() => onColorChange(option.value)}
											style={{ backgroundColor: option.value }}
											type="button"
										/>
									))}
								</div>
							</>
						) : (
							<p className="py-8 text-center text-muted-foreground text-xs">
								{tab === "Gerar" ? "Em breve" : "Enviar imagem"}
							</p>
						)}
					</div>
				</DropdownMenuContent>
			</DropdownMenu>
		</Tooltip>
	);
}
