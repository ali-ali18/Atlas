import * as React from "react";
import { Image, View } from "react-native";
import { FileIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, PresentationIcon } from "@/components/icons";
import { MarkdownBlocks, MarkdownText, TableCard } from "@/components/chat/markdown-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { csvToTable, MAX_CSV_ROWS, prettyJson, unsupportedIconKind } from "@/lib/document-view";
import type { FileTarget } from "@/lib/file-api";
import type { DocumentState } from "@/lib/use-document";
import { useAppColorScheme } from "@/lib/use-theme";
import type { LibraryItemKind } from "@/lib/library-items";

function KindIcon({ kind }: { kind: LibraryItemKind }) {
	switch (kind) {
		case "document":
			return <FileTextIcon size={32} tone="muted-foreground" />;
		case "sheet":
			return <FileSpreadsheetIcon size={32} tone="muted-foreground" />;
		case "presentation":
			return <PresentationIcon size={32} tone="muted-foreground" />;
		case "image":
			return <ImageIcon size={32} tone="muted-foreground" />;
		default:
			return <FileIcon size={32} tone="muted-foreground" />;
	}
}

/** Estado sem conteúdo para mostrar (tipo sem visualizador, grande demais, erro): ícone, frase e uma ação. */
function Notice({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
	return (
		<View className="items-center gap-3 px-6 pt-16">
			{icon}
			<Text accessibilityRole="header" className="text-center text-lg font-semibold">
				{title}
			</Text>
			{hint ? (
				<Text variant="muted" className="text-center text-control">
					{hint}
				</Text>
			) : null}
			{action}
		</View>
	);
}

/** Imagem; se não decodificar (arquivo corrompido, formato que o aparelho não abre), cai no aviso "não dá para ver" com compartilhar. */
function ImageBody({ uri, label, fallback }: { uri: string; label: string; fallback: React.ReactNode }) {
	const [ratio, setRatio] = React.useState(4 / 3);
	const [failed, setFailed] = React.useState(false);
	if (failed) return <>{fallback}</>;
	return (
		<Image
			source={{ uri }}
			accessibilityLabel={label}
			resizeMode="contain"
			onError={() => setFailed(true)}
			onLoad={(event) => {
				const { width, height } = event.nativeEvent.source;
				if (width > 0 && height > 0) setRatio(width / height);
			}}
			style={{ width: "100%", aspectRatio: ratio, borderRadius: 12 }}
		/>
	);
}

/**
 * Corpo da folha de um documento. Texto vira markdown, tabela (CSV) ou bloco de código; imagem aparece inteira; o resto
 * (PDF, Office…) diz que ainda não dá para ver e deixa compartilhar. O conteúdo é dado não confiável: nada de HTML nem
 * WebView, e o `MarkdownText` só abre link http(s).
 */
export function DocumentBody({ state, target, onRetry, onShare, sharing }: { state: DocumentState; target: FileTarget; onRetry: () => void; onShare: () => void; sharing: boolean }) {
	const scheme = useAppColorScheme();
	const csv = React.useMemo(() => (state.status === "ready" && state.content.type === "text" && state.content.view === "csv" ? csvToTable(state.content.text) : null), [state]);
	if (state.status === "loading") {
		return (
			<View className="items-center pt-24">
				<Spinner label="Carregando documento" />
			</View>
		);
	}
	if (state.status === "error") {
		return (
			<Notice
				icon={<FileIcon size={32} tone="muted-foreground" />}
				title={state.message}
				action={
					state.retryable ? (
						<Button variant="secondary" onPress={onRetry}>
							<Text>Tentar de novo</Text>
						</Button>
					) : undefined
				}
			/>
		);
	}
	const { content } = state;
	const shareButton = (
		<Button variant="secondary" disabled={sharing} onPress={onShare}>
			<Text>{sharing ? "Preparando…" : "Compartilhar"}</Text>
		</Button>
	);
	const unsupported = <Notice icon={<KindIcon kind={unsupportedIconKind(target.mime ?? "", target.filename)} />} title="Ainda não dá para ver este tipo de arquivo aqui" hint="Você pode compartilhar o arquivo e abrir em outro app." action={shareButton} />;
	switch (content.type) {
		case "unsupported":
			return unsupported;
		case "too-large":
			return <Notice icon={<FileTextIcon size={32} tone="muted-foreground" />} title="Documento grande demais para abrir aqui" hint="Compartilhe o arquivo para abrir em outro app." action={shareButton} />;
		case "image":
			return <ImageBody uri={content.uri} label={target.filename} fallback={unsupported} />;
		case "text":
			break;
	}
	if (content.text.trim() === "") return <Notice icon={<FileTextIcon size={32} tone="muted-foreground" />} title="Este documento está vazio" />;
	switch (content.view) {
		case "markdown":
			return <MarkdownText source={content.text} />;
		case "csv":
			return csv?.block ? (
				<View className="gap-3">
					<TableCard block={csv.block} scheme={scheme} />
					{csv.totalRows > csv.shownRows ? (
						<Text variant="caption">
							Mostrando as primeiras {MAX_CSV_ROWS} de {csv.totalRows} linhas.
						</Text>
					) : null}
				</View>
			) : (
				<Notice icon={<FileSpreadsheetIcon size={32} tone="muted-foreground" />} title="Esta planilha está vazia" />
			);
		case "json":
			return <MarkdownBlocks blocks={[{ type: "code", text: prettyJson(content.text), lang: "json" }]} />;
		case "code":
			return <MarkdownBlocks blocks={[{ type: "code", text: content.text, lang: "" }]} />;
		default:
			return (
				<Text selectable className="text-base leading-snug">
					{content.text}
				</Text>
			);
	}
}
