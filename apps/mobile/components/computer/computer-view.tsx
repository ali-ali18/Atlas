import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Image, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoundButton, TOP_BAR_CONTROL, TOP_BAR_SIDE } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon, ClipboardPasteIcon, CloseIcon, HelpIcon, KeyboardIcon, MonitorIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { Zoomable } from "@/components/computer/zoomable";
import type { MobileAvatarState } from "@/lib/avatar-activity";
import type { HomeBot } from "@/lib/home-types";

/** Estado da tela: carregando a sessão, pronta (mostra o computador), computador desligado ou erro ao conectar. */
export type ComputerStatus = "loading" | "ready" | "off" | "error";

/** A tela do Computador é sempre escura (como no Grok), qualquer que seja o tema do app. */
const SCREEN = "#000000";
const PILL_FILL = "#2c2c2e";
const PILL_EDGE = "#4b4b4d";
const SIDE = TOP_BAR_SIDE;

export type ComputerViewProps = {
	bot: Pick<HomeBot, "id" | "name" | "color" | "shape">;
	avatarState?: MobileAvatarState;
	status: ComputerStatus;
	/** Imagem do desktop remoto (uri). Alternativa: `children` com o conteúdo remoto. */
	source?: { uri: string };
	children?: React.ReactNode;
	/** Proporção do quadro remoto (largura / altura). Padrão 16:9. */
	aspectRatio?: number;
	/** O usuário está no controle (o botão vira "Soltar o controle" e aparece a barra de ações). */
	controlling?: boolean;
	onBack: () => void;
	onHelp?: () => void;
	onTakeControl?: () => void;
	onRelease?: () => void;
	onPaste?: () => void;
	onKeyboard?: () => void;
	onRetry?: () => void;
};

/** Botão redondo da barra de ações (Colar, Teclado, Soltar), com o rótulo embaixo. */
function ActionButton({ label, onPress, children }: { label: string; onPress?: () => void; children: React.ReactNode }) {
	return (
		<View className="items-center gap-1.5">
			<Pressable role="button" accessibilityLabel={label} onPress={onPress} style={{ width: 52, height: 52, backgroundColor: PILL_FILL, borderColor: PILL_EDGE }} className="items-center justify-center rounded-full border active:opacity-70">
				{children}
			</Pressable>
			<Text className="text-caption" style={{ color: "#d4d4d8" }}>
				{label}
			</Text>
		</View>
	);
}

function Placeholder({ status, onRetry }: { status: Exclude<ComputerStatus, "ready">; onRetry?: () => void }) {
	if (status === "loading") {
		return (
			<View className="flex-1 items-center justify-center gap-3">
				<Spinner size="large" label="Conectando ao computador" />
				<Text className="text-control" style={{ color: "#a1a1aa" }}>
					Conectando ao computador…
				</Text>
			</View>
		);
	}
	const off = status === "off";
	return (
		<View className="flex-1 items-center justify-center gap-2 px-10">
			<MonitorIcon size={40} tone="muted-foreground" />
			<Text className="mt-2 text-center text-lg font-semibold" style={{ color: "#ffffff" }}>
				{off ? "O computador do bot está desligado." : "Não deu para conectar ao computador."}
			</Text>
			<Text className="text-center text-control" style={{ color: "#a1a1aa" }}>
				{off ? "Peça ao bot uma tarefa que use o computador e ele liga sozinho." : "Confira sua conexão e tente de novo."}
			</Text>
			{off ? null : (
				<Button variant="secondary" className="mt-4 rounded-full px-6" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			)}
		</View>
	);
}

/**
 * Tela do Computador do bot (padrão do Grok, sempre escura): topo com voltar, avatar e nome do bot e "?"; a imagem do
 * desktop remoto no meio, com zoom por pinça; "Assumir o controle" embaixo à direita. No controle, o botão vira "Soltar
 * o controle" e aparece a barra Colar · Teclado · Soltar. Só apresentação: quem usa liga os callbacks (sem lógica de VM).
 */
export function ComputerView({ bot, avatarState = "idle", status, source, children, aspectRatio = 16 / 9, controlling = false, onBack, onHelp, onTakeControl, onRelease, onPaste, onKeyboard, onRetry }: ComputerViewProps) {
	const insets = useSafeAreaInsets();
	const ready = status === "ready";
	return (
		<View className="flex-1" style={{ backgroundColor: SCREEN }}>
			<View style={{ paddingTop: insets.top + 6, paddingHorizontal: SIDE, height: insets.top + 6 + TOP_BAR_CONTROL }} className="flex-row items-center gap-3">
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<View className="min-w-0 shrink flex-row items-center gap-2">
					<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={32} animated look state={avatarState} eyeColor={SCREEN} />
					<Text numberOfLines={1} className="min-w-0 shrink text-control font-semibold" style={{ color: "#ffffff" }}>
						{bot.name}
					</Text>
				</View>
				<View className="flex-1" />
				<RoundButton label="Ajuda" onPress={onHelp ?? (() => undefined)}>
					<HelpIcon />
				</RoundButton>
			</View>

			{ready ? (
				<Zoomable aspectRatio={aspectRatio}>
					{source ? <Image source={source} resizeMode="contain" accessibilityLabel={`Tela do computador de ${bot.name}`} style={{ width: "100%", height: "100%" }} /> : children}
				</Zoomable>
			) : (
				<Placeholder status={status} onRetry={onRetry} />
			)}

			{ready ? (
				<View style={{ paddingBottom: insets.bottom + 16, paddingHorizontal: SIDE }} className="gap-5">
					<View className="items-end">
						<Pressable
							role="button"
							accessibilityLabel={controlling ? "Soltar o controle" : "Assumir o controle"}
							onPress={controlling ? onRelease : onTakeControl}
							style={{ height: 46, backgroundColor: PILL_FILL, borderColor: PILL_EDGE }}
							className="items-center justify-center rounded-full border px-5 active:opacity-70"
						>
							<Text className="text-control font-medium" style={{ color: "#ffffff" }}>
								{controlling ? "Soltar o controle" : "Assumir o controle"}
							</Text>
						</Pressable>
					</View>
					{controlling ? (
						<View className="flex-row items-start justify-center gap-8">
							<ActionButton label="Colar" onPress={onPaste}>
								<ClipboardPasteIcon />
							</ActionButton>
							<ActionButton label="Teclado" onPress={onKeyboard}>
								<KeyboardIcon />
							</ActionButton>
							<ActionButton label="Soltar" onPress={onRelease}>
								<CloseIcon size={22} tone="foreground" />
							</ActionButton>
						</View>
					) : null}
				</View>
			) : (
				<View style={{ height: insets.bottom + 16 }} />
			)}
		</View>
	);
}
