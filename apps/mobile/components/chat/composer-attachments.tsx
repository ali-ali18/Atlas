import * as React from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { CloseIcon } from "@/components/icons";
import { FileTile } from "@/components/ui/file-tile";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { AttachmentDraft } from "@/lib/attachments";
import { cn } from "@/lib/cn";
import { fileCardKind, fileCardTitle, splitFileName } from "@/lib/file-card";
import { localImageUri } from "@/lib/image-viewer";
import { useSurfaces } from "@/lib/use-surfaces";

const THUMB = 44;

function RemoveButton({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const surfaces = useSurfaces();
	return (
		<Pressable
			role="button"
			accessibilityLabel={`${draft.status === "uploading" ? "Cancelar" : "Remover"} ${draft.name}`}
			onPress={() => onRemove(draft.key)}
			hitSlop={8}
			style={{ backgroundColor: surfaces.chromeControl, borderColor: surfaces.chromeEdge }}
			className="absolute -right-1.5 -top-1.5 size-5 items-center justify-center rounded-full border active:opacity-70"
		>
			<CloseIcon size={10} tone="foreground" />
		</Pressable>
	);
}

/** Miniatura de 44 px: a própria foto (local), com véu e spinner enquanto sobe e contorno destructive no erro. */
function ImageChip({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const failed = draft.status === "error";
	const surfaces = useSurfaces();
	const source = localImageUri({ uri: draft.uri });
	return (
		<View style={{ width: THUMB, height: THUMB }} accessibilityLabel={`${draft.name}${failed ? ", falhou" : draft.status === "uploading" ? ", enviando" : ""}`}>
			<View style={{ width: THUMB, height: THUMB, ...(failed ? null : { borderColor: surfaces.chromeEdge }) }} className={cn("overflow-hidden rounded-lg border bg-foreground/[0.06]", failed && "border-destructive")}>
				{source ? <Image source={{ uri: source }} style={{ width: THUMB, height: THUMB }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
				{draft.status === "uploading" ? (
					<View className="absolute inset-0 items-center justify-center bg-background/60">
						<Spinner />
					</View>
				) : null}
				{failed ? <View className="absolute inset-0 bg-destructive/20" /> : null}
			</View>
			<RemoveButton draft={draft} onRemove={onRemove} />
		</View>
	);
}

/** Arquivo: o ícone com faixa do tipo (`FileTile`) e o nome; o spinner troca o ícone enquanto sobe. */
function FileChip({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const failed = draft.status === "error";
	const surfaces = useSurfaces();
	const kind = fileCardKind(draft.name, draft.mime);
	const { ext } = splitFileName(draft.name);
	return (
		<View accessibilityLabel={`${draft.name}${failed ? ", falhou" : draft.status === "uploading" ? ", enviando" : ""}`}>
			<View style={{ height: THUMB, ...(failed ? null : { borderColor: surfaces.chromeEdge }) }} className={cn("max-w-[180px] flex-row items-center gap-2 overflow-hidden rounded-lg border bg-foreground/[0.06] pr-3", failed && "border-destructive")}>
				<View className="items-center justify-center">
					<FileTile glyph={kind.glyph} tone={kind.tone} className={cn("rounded-none", draft.status === "uploading" && "opacity-30")} />
					{draft.status === "uploading" ? (
						<View className="absolute inset-0 items-center justify-center">
							<Spinner />
						</View>
					) : null}
				</View>
				<View className="min-w-0 shrink">
					<Text numberOfLines={1} ellipsizeMode="middle" variant="caption" className="text-foreground">
						{fileCardTitle(draft.name)}
					</Text>
					{ext ? (
						<Text numberOfLines={1} variant="caption">
							{ext}
						</Text>
					) : null}
				</View>
			</View>
			<RemoveButton draft={draft} onRemove={onRemove} />
		</View>
	);
}

/**
 * Anexos escolhidos, acima do campo e dentro do mesmo container do composer (como o `ReplyChip`). Um aviso embaixo
 * diz por que um item não entrou ou falhou. Nada aqui desenha pele própria: bordas e véus usam os tokens do tema.
 */
export function ComposerAttachments({ drafts, notice, onRemove }: { drafts: readonly AttachmentDraft[]; notice: string | null; onRemove: (key: string) => void }) {
	if (drafts.length === 0 && !notice) return null;
	const failure = drafts.find((draft) => draft.status === "error")?.error ?? null;
	const message = failure ?? notice;
	return (
		<View className="gap-2 px-3 pb-1 pt-3">
			{drafts.length > 0 ? (
				<View className="flex-row flex-wrap gap-x-3 gap-y-3 pt-1.5">
					{drafts.map((draft) => (draft.route === "image" ? <ImageChip key={draft.key} draft={draft} onRemove={onRemove} /> : <FileChip key={draft.key} draft={draft} onRemove={onRemove} />))}
				</View>
			) : null}
			{message ? (
				<Text variant="caption" accessibilityLiveRegion="polite" className={failure ? "text-destructive" : undefined}>
					{message}
				</Text>
			) : null}
		</View>
	);
}
