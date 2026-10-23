"use client";

import type { PlusIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";

/** Botão do cabeçalho da seção: no celular só o ícone (nome no tooltip); no desktop ícone e texto. */
export function SectionAction({ icon: Icon, label, onClick, disabled }: { icon: typeof PlusIcon; label: string; onClick?: () => void; disabled?: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button aria-label={label} className="max-md:w-8 max-md:px-0" disabled={disabled} onClick={onClick} size="sm" type="button" variant="outline">
						<Icon aria-hidden />
						<span className="max-md:hidden">{label}</span>
					</Button>
				}
			/>
			<TooltipContent className="md:hidden">{label}</TooltipContent>
		</Tooltip>
	);
}
