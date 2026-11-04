import { FileIcon, FileSpreadsheetIcon, FileTextIcon, PresentationIcon } from "@/components/icons";
import { View } from "react-native";
import { cn } from "@/lib/cn";
import type { FileGlyph, FileTone } from "@/lib/file-card";

const BAND: Record<FileTone, string> = {
	destructive: "bg-destructive",
	info: "bg-info",
	success: "bg-success",
	warning: "bg-warning",
	muted: "bg-muted-foreground",
};

function Glyph({ glyph }: { glyph: FileGlyph }) {
	switch (glyph) {
		case "text":
			return <FileTextIcon />;
		case "sheet":
			return <FileSpreadsheetIcon />;
		case "presentation":
			return <PresentationIcon />;
		default:
			return <FileIcon />;
	}
}

/**
 * Ícone de arquivo com faixa de cor embaixo indicando o tipo (vermelho no PDF). Peça comum dos cartões de arquivo e
 * documento do chat; a cor vem de `fileCardKind`, nunca de hex.
 */
export function FileTile({ glyph, tone, className }: { glyph: FileGlyph; tone: FileTone; className?: string }) {
	return (
		<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className={cn("h-11 w-10 shrink-0 overflow-hidden rounded-lg bg-foreground/[0.06]", className)}>
			<View className="flex-1 items-center justify-center">
				<Glyph glyph={glyph} />
			</View>
			<View className={cn("h-1.5 w-full", BAND[tone])} />
		</View>
	);
}
