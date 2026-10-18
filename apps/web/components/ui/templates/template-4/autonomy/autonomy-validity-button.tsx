"use client";

import { ClockIcon } from "lucide-react";
import {
	AUTONOMY_DURATIONS,
	AUTONOMY_DURATION_LABELS,
	type AutonomyDuration,
} from "@workspace/shared";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

/**
 * Botão de relógio ao lado do nível: abre a validade da autonomia.
 * `value` é "current" quando há validade ativa que não bate com uma opção.
 */
export function AutonomyValidityButton({
	value,
	currentLabel,
	active,
	disabled,
	onChange,
}: {
	value: AutonomyDuration | "current";
	/** Texto do tooltip quando `value` é "current" (ex.: "Mais 3 dias"). */
	currentLabel?: string;
	active: boolean;
	disabled?: boolean;
	onChange: (value: AutonomyDuration) => void;
}) {
	const label =
		value === "current" && currentLabel
			? currentLabel
			: AUTONOMY_DURATION_LABELS[value as AutonomyDuration];
	return (
		<Tooltip>
			<DropdownMenu>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							aria-label="Por quanto tempo"
							className={cn(
								"relative grid size-9 shrink-0 place-items-center rounded-full border border-transparent bg-input/50 text-muted-foreground transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
								active && "text-primary",
							)}
							disabled={disabled}
							type="button"
						>
							<ClockIcon className="size-4" />
							{active ? (
								<span
									aria-hidden
									className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
								/>
							) : null}
						</DropdownMenuTrigger>
					}
				/>
				<TooltipContent className="px-2 py-1 text-[11px]">
					{label}
				</TooltipContent>
				<DropdownMenuContent align="end">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Por quanto tempo</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							onValueChange={(next) => onChange(next as AutonomyDuration)}
							value={value === "current" ? "" : value}
						>
							{AUTONOMY_DURATIONS.map((duration) => (
								<DropdownMenuRadioItem key={duration} value={duration}>
									{AUTONOMY_DURATION_LABELS[duration]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</Tooltip>
	);
}
