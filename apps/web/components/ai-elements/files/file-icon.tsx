import {
	FileArchiveIcon,
	FileCodeIcon,
	FileIcon,
	FileImageIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	PresentationIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@workspace/ui/lib/utils";
import type { FileCategory } from "@workspace/shared";

import { FILE_CATEGORY_TONE } from "@/lib/file-card";

const ICONS: Record<FileCategory, ComponentType<{ className?: string }>> = {
	pdf: FileTextIcon,
	docx: FileTextIcon,
	sheet: FileSpreadsheetIcon,
	pptx: PresentationIcon,
	code: FileCodeIcon,
	text: FileIcon,
	image: FileImageIcon,
	archive: FileArchiveIcon,
};

/** Ícone do tipo de arquivo, com a cor da categoria (PDF vermelho, DOCX azul...). */
export function FileTypeIcon({ category, className }: { category: FileCategory; className?: string }) {
	const Icon = ICONS[category];
	return (
		<span
			aria-hidden="true"
			className={cn("grid size-full place-items-center", FILE_CATEGORY_TONE[category], className)}
		>
			<Icon className="size-5" />
		</span>
	);
}
