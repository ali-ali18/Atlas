"use client";

import { Loader2Icon, XIcon } from "lucide-react";

import { FileTypeIcon } from "@/components/ai-elements/files/file-icon";
import type { FileAttachment } from "@/hooks/use-file-attachments";
import { fileCardDescription, fileCategory } from "@/lib/file-card";
import { InputGroupAddon } from "@workspace/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

/** Linha horizontal (com rolagem) de chips de 44px dos anexos do composer. */
export const CHIP_ROW_CLASS = "flex w-full min-w-0 gap-2 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none]";
export const CHIP_REMOVE_CLASS =
	"touch-hit absolute -top-1 -right-1 z-10 grid size-5 place-items-center rounded-full bg-foreground text-background shadow outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring md:opacity-0 md:group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100";

function statusText(item: FileAttachment): string {
	if (item.status === "uploading") return "Enviando…";
	if (item.status === "error") return item.error ?? "Falha no envio";
	return fileCardDescription({ filename: item.file.name, size: item.file.size });
}

/**
 * Anexos de arquivo no composer: só o ícone do tipo (44px). Nome, tipo e tamanho ficam no tooltip
 * (hover, foco ou toque); x remove; spinner no envio; borda vermelha no erro.
 */
export function ComposerFileAttachments({
	items,
	onRemove,
}: {
	items: readonly FileAttachment[];
	onRemove: (localId: string) => void;
}) {
	if (items.length === 0) return null;
	return (
		<InputGroupAddon align="block-start" className="px-3 pt-3 pb-1">
			<ul aria-label="Arquivos anexados" className={CHIP_ROW_CLASS}>
				{items.map((item) => {
					const label = `${item.file.name}, ${statusText(item)}`;
					return (
						<li className="group/chip relative shrink-0" data-testid="composer-file" data-state={item.status} key={item.localId}>
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											aria-label={label}
											className={cn(
												"relative grid size-11 place-items-center overflow-hidden rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring",
												item.status === "error" && "border-destructive",
											)}
											type="button"
										/>
									}
								>
									<FileTypeIcon category={fileCategory(item.file.name)} className="rounded-xl" />
									{item.status === "uploading" ? (
										<span className="absolute inset-0 grid place-items-center bg-background/70">
											<Loader2Icon aria-hidden className="size-5 animate-spin" />
										</span>
									) : null}
								</TooltipTrigger>
								<TooltipContent className="flex-col items-start gap-0.5" side="top">
									<span className="max-w-60 break-all font-medium">{item.file.name}</span>
									<span className="opacity-80">{statusText(item)}</span>
								</TooltipContent>
							</Tooltip>
							<button aria-label={`Remover ${item.file.name}`} className={CHIP_REMOVE_CLASS} onClick={() => onRemove(item.localId)} type="button">
								<XIcon aria-hidden className="size-3" />
							</button>
						</li>
					);
				})}
			</ul>
		</InputGroupAddon>
	);
}
