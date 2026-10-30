"use client";

import {
	Attachment,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import { InputGroupAddon } from "@workspace/ui/components/input-group";
import { useT } from "@/lib/i18n/provider";

/** Miniaturas de imagem no mesmo formato de chip (44px) dos arquivos; rolam na horizontal. */
export function ComposerImageAttachments({
	items,
	onRemove,
}: {
	items: readonly ImageAttachment[];
	onRemove: (localId: string) => void;
}) {
	const t = useT();
	if (items.length === 0) return null;

	return (
		<InputGroupAddon align="block-start" className="px-3 pt-3 pb-1">
			<Attachments className="ml-0 w-full flex-nowrap overflow-x-auto py-1 [scrollbar-width:none]" variant="grid">
				{items.map((item) => (
					<Attachment
						className="group/chip size-11 shrink-0 overflow-visible rounded-xl"
						data={{ id: item.localId, type: "file", mediaType: item.file.type, filename: item.file.name, url: item.previewUrl }}
						key={item.localId}
						onRemove={() => onRemove(item.localId)}
					>
						<AttachmentPreview className="overflow-hidden rounded-xl [&_img]:object-cover" />
						{item.status === "uploading" && (
							<span aria-label={t("composer.uploadingImage")} className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-background/60 text-[10px]">…</span>
						)}
						{item.status === "error" && (
							<span className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl border border-destructive bg-destructive/80 text-center text-[10px] text-white" title={item.error}>{t("composer.imageError")}</span>
						)}
						<AttachmentRemove
							className="-top-1 -right-1 z-10 size-5 rounded-full bg-foreground text-background opacity-100 hover:bg-foreground/90 hover:text-background md:opacity-0 md:group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100 [&>svg]:size-3"
							label={t("composer.remove", { name: item.file.name })}
						/>
					</Attachment>
				))}
			</Attachments>
		</InputGroupAddon>
	);
}
