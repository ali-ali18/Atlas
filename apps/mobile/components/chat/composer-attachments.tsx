import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { X as LucideX } from "lucide-react-native";
import { Image } from "expo-image";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { AttachmentDraft } from "@/lib/attachments";
import { cn } from "@/lib/cn";
import { fileCardTitle, splitFileName } from "@/lib/file-card";
import { localImageUri } from "@/lib/image-viewer";
import { useSurfaces } from "@/lib/use-surfaces";

const TILE = 88;
const TILE_RADIUS = 14;

function RemoveButton({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const surfaces = useSurfaces();
	return (
		<Pressable
			role="button"
			accessibilityLabel="Remover anexo"
			onPress={() => onRemove(draft.key)}
			hitSlop={6}
			style={{ backgroundColor: surfaces.inverseFill }}
			className="absolute right-[5px] top-[5px] size-6 items-center justify-center rounded-full active:opacity-70"
		>
			<LucideX size={12} color={surfaces.inverseInk} strokeWidth={2.5} />
		</Pressable>
	);
}

function statusLabel(draft: AttachmentDraft) {
	return `${draft.name}${draft.status === "error" ? ", falhou" : draft.status === "uploading" ? ", enviando" : ""}`;
}

/** Véu escuro leve e spinner no centro enquanto o anexo sobe. */
function UploadingVeil() {
	return (
		<View className="absolute inset-0 items-center justify-center bg-background/50">
			<Spinner />
		</View>
	);
}

/** Casca quadrada comum: mesmo tamanho para foto e arquivo; contorno destructive no erro. */
function Tile({ draft, onRemove, children, fill }: { draft: AttachmentDraft; onRemove: (key: string) => void; children: React.ReactNode; fill?: string }) {
	const failed = draft.status === "error";
	const surfaces = useSurfaces();
	return (
		<View style={{ width: TILE, height: TILE }} accessibilityLabel={statusLabel(draft)}>
			<View
				style={{ width: TILE, height: TILE, borderRadius: TILE_RADIUS, backgroundColor: fill, ...(failed ? null : { borderColor: surfaces.chromeEdge }) }}
				className={cn("overflow-hidden border", failed && "border-destructive")}
			>
				{children}
				{draft.status === "uploading" ? <UploadingVeil /> : null}
			</View>
			<RemoveButton draft={draft} onRemove={onRemove} />
		</View>
	);
}

/** Foto: a miniatura preenche o tile inteiro. */
function ImageChip({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const surfaces = useSurfaces();
	const source = localImageUri({ uri: draft.uri });
	return (
		<Tile draft={draft} onRemove={onRemove} fill={surfaces.chromeControl}>
			{source ? <Image source={{ uri: source }} style={{ width: TILE, height: TILE }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
		</Tile>
	);
}

/** Arquivo: selo da extensão em cima à esquerda e o nome sem extensão (até 2 linhas) embaixo. */
function FileChip({ draft, onRemove }: { draft: AttachmentDraft; onRemove: (key: string) => void }) {
	const surfaces = useSurfaces();
	const { ext } = splitFileName(draft.name);
	return (
		<Tile draft={draft} onRemove={onRemove} fill={surfaces.chromeControl}>
			<View className="flex-1 justify-between p-2.5">
				<View className="flex-row">
					{ext ? (
						<View style={{ borderColor: surfaces.chromeEdge }} className="rounded-full border px-1.5 py-px">
							<Text numberOfLines={1} variant="caption" className="text-[9px] font-medium leading-[12px] text-foreground">
								{ext}
							</Text>
						</View>
					) : null}
				</View>
				<Text numberOfLines={2} ellipsizeMode="tail" variant="caption" className="text-left text-foreground">
					{fileCardTitle(draft.name)}
				</Text>
			</View>
		</Tile>
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
		<View className="gap-2 px-3 pb-3 pt-3">
			{drafts.length > 0 ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
					{drafts.map((draft) => (draft.route === "image" ? <ImageChip key={draft.key} draft={draft} onRemove={onRemove} /> : <FileChip key={draft.key} draft={draft} onRemove={onRemove} />))}
				</ScrollView>
			) : null}
			{message ? (
				<Text variant="caption" accessibilityLiveRegion="polite" className={failure ? "text-destructive" : undefined}>
					{message}
				</Text>
			) : null}
		</View>
	);
}
