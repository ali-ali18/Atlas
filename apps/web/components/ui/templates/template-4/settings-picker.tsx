"use client";

import { useRef, useState, type ComponentType } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";

/** Só mostra o tooltip nativo quando o texto provavelmente está truncado. */
const TITLE_MIN_LENGTH = 28;

/** Qualquer ícone que aceite `className` (lucide ou SVG de marca). */
export type SettingsIcon = ComponentType<{ className?: string }>;

export type SettingsPickerOption<T extends string> = {
	value: T;
	label: string;
	description?: string;
	/** Ícone à esquerda do rótulo, no menu e no trigger quando selecionada. */
	icon?: SettingsIcon;
};

/** Anexa ícones às opções pelo valor, sem poluir a lógica pura que monta as opções. */
export function withOptionIcons<T extends string>(
	options: readonly SettingsPickerOption<T>[],
	icons: Partial<Record<T, SettingsIcon>>,
): SettingsPickerOption<T>[] {
	return options.map((option) => ({ ...option, icon: icons[option.value] ?? option.icon }));
}

const OPTION_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

/**
 * Seletor em dropdown (trigger no estilo dos campos do painel + menu radio).
 * `triggerLabel` sobrescreve o rótulo mostrado quando difere do da opção.
 */
export function SettingsPicker<T extends string>({
	value,
	options,
	onChange,
	triggerLabel,
	placeholder,
	disabled,
	size = "default",
	className,
	...aria
}: {
	value: T | "";
	options: readonly SettingsPickerOption<T>[];
	onChange: (value: T) => void;
	triggerLabel?: string;
	placeholder?: string;
	disabled?: boolean;
	size?: "sm" | "default";
	className?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	id?: string;
}) {
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	// Dentro de um cartão de configurações o painel alinha às bordas do cartão (mesmo x nos dois lados).
	const [card, setCard] = useState<{ offset: number; width: number } | null>(null);
	const measureCard = (open: boolean) => {
		if (!open) return;
		const trigger = triggerRef.current;
		const group = trigger?.closest<HTMLElement>('[data-slot="settings-group"]');
		if (!trigger || !group) return setCard(null);
		const t = trigger.getBoundingClientRect();
		const g = group.getBoundingClientRect();
		setCard({ offset: g.left - t.left, width: g.width });
	};
	const current = options.find((option) => option.value === value);
	const text = triggerLabel ?? current?.label ?? placeholder ?? "";
	return (
		<DropdownMenu onOpenChange={measureCard}>
			<DropdownMenuTrigger
				{...aria}
				ref={triggerRef}
				className={cn(
					"flex w-full min-w-0 items-center justify-between gap-1.5 rounded-3xl border border-transparent bg-input/50 px-3 py-2 text-sm whitespace-nowrap transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
					size === "sm" ? "h-8" : "h-9",
					!current && !triggerLabel && "text-muted-foreground",
					className,
				)}
				data-slot="settings-picker-trigger"
				disabled={disabled}
				title={text.length > TITLE_MIN_LENGTH ? text : undefined}
				type="button"
			>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					{current?.icon && !triggerLabel ? (
						<current.icon aria-hidden className={OPTION_ICON_CLASS} />
					) : null}
					<span className="min-w-0 flex-1 truncate text-left">{text}</span>
				</span>
				<ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align={card ? "start" : "end"}
				alignOffset={card ? card.offset : 0}
				collisionPadding={card ? 0 : 12}
				className={card ? "max-w-none min-w-0 rounded-[12px]" : "w-auto max-w-[22rem] min-w-[max(var(--anchor-width),18rem)]"}
				style={card ? { width: card.width } : undefined}
				data-slot="settings-picker-content"
			>
				<DropdownMenuRadioGroup
					onValueChange={(next) => onChange(next as T)}
					value={value}
				>
					{options.map((option) => (
						<DropdownMenuRadioItem key={option.value} value={option.value}>
							<div className="flex min-w-0 flex-1 items-start gap-2">
								{option.icon ? (
									<option.icon aria-hidden className={cn(OPTION_ICON_CLASS, "mt-0.5")} />
								) : null}
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-sm">{option.label}</span>
									{option.description ? (
										<span className="text-xs font-normal whitespace-normal text-muted-foreground">
											{option.description}
										</span>
									) : null}
								</div>
							</div>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
