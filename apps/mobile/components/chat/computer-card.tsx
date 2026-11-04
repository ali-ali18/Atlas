import { useIsFocused } from "expo-router";
import * as React from "react";
import { Image, Pressable, View } from "react-native";
import { ClockIcon, LaptopIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import type { ResumeOptions } from "@/lib/chat-api";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { computerNote, computerResumeOptions, computerSubtitle, deadlineLine, loginOutcome, siteName, type ComputerAction } from "@/lib/request-cards";
import { useAppState } from "@/lib/use-app-state";
import { useComputerFrame } from "@/lib/use-computer-frame";
import { useAppColorScheme } from "@/lib/use-theme";
import { RequestButton, RequestShell } from "./request-shell";

type Login = Extract<ChatItem, { kind: "login" }>;

/** Hora atual que se atualiza sozinha quando o prazo vence (para a linha virar "Tempo esgotado"). */
function useNow(deadlineAt: string | undefined, enabled: boolean): number {
	const [now, setNow] = React.useState(() => Date.now());
	React.useEffect(() => {
		if (!enabled || !deadlineAt) return;
		const left = new Date(deadlineAt).getTime() - Date.now();
		if (!(left > 0)) return setNow(Date.now());
		// setTimeout aceita no máximo ~24 dias; prazos do contrato são minutos/horas.
		const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 250, 2_000_000_000));
		return () => clearTimeout(timer);
	}, [deadlineAt, enabled]);
	return now;
}

/** Miniatura da tela da VM (16:10, cantos arredondados, borda do chrome). Tocar abre o Computador em tela cheia. */
function Thumb({ uri, onOpen }: { uri: string | null; onOpen: () => void }) {
	const chrome = chatChrome(useAppColorScheme());
	return (
		<Pressable role="button" accessibilityLabel="Abrir a tela do computador" onPress={onOpen} className="w-full overflow-hidden rounded-2xl border active:opacity-80" style={{ aspectRatio: 16 / 10, borderColor: chrome.edge, backgroundColor: chrome.control }}>
			{uri ? (
				<Image source={{ uri }} accessibilityIgnoresInvertColors resizeMode="cover" style={{ width: "100%", height: "100%" }} />
			) : (
				<View className="size-full items-center justify-center gap-2">
					<LaptopIcon size={22} />
					<Text variant="caption" className="text-caption">
						Carregando a tela…
					</Text>
				</View>
			)}
		</Pressable>
	);
}

/**
 * Cartão "Computador · Ação necessária" (motor v3): o bot parou numa página que pede uma ação na VM (login sem conector,
 * verificação) e devolve a tela ao dono. Mesma pele dos demais pedidos (`RequestShell`). Mostra a tela AO VIVO enquanto
 * está pendente (captura a cada poucos segundos, só com o cartão pendente, a tela em foco e o app ativo). Botões:
 * Pular · Terminei · Assumir (este abre o Computador). Resolvido: só o selo do desfecho.
 * `frameUri` fixa a imagem e desliga a busca (prévia e testes visuais).
 */
export function ComputerCard({ item, botName, conversationId, onResume, onOpenComputer, frameUri }: { item: Login; botName: string; conversationId: string | null; onResume: (item: Login, options: ResumeOptions) => void; onOpenComputer: () => void; frameUri?: string }) {
	const { apiFetch } = useAtlasSession();
	const focused = useIsFocused();
	const appState = useAppState();
	const pending = item.status === "pending";
	const badge = loginOutcome(item);
	const live = useComputerFrame({ apiFetch, conversationId, enabled: pending && !frameUri && focused && appState === "active" });
	const now = useNow(item.deadlineAt, pending);
	const deadline = pending ? deadlineLine(item.deadlineAt, now) : null;
	const site = siteName(item);
	const act = (action: ComputerAction) => {
		onResume(item, computerResumeOptions(action));
		if (action === "takeover") onOpenComputer();
	};

	return (
		<RequestShell icon={<LaptopIcon />} label="Computador" badge={badge ?? undefined} groupLabel={`Ação necessária no computador: ${site}`} note={pending ? computerNote(botName) : undefined} noteIcon>
			<View className="gap-1">
				<Text className="text-base font-semibold">Ação necessária</Text>
				<Text variant="muted" className="text-body">
					{computerSubtitle(item)}
				</Text>
			</View>
			{pending ? (
				<>
					<Thumb uri={frameUri ?? live} onOpen={onOpenComputer} />
					{deadline ? (
						<View className="flex-row items-center gap-1.5">
							<ClockIcon size={14} />
							<Text variant="caption" className="min-w-0 flex-1 text-caption">
								{deadline}
							</Text>
						</View>
					) : null}
					<View className="flex-row items-center justify-end gap-2">
						<RequestButton label="Pular" variant="secondary" onPress={() => act("skip")} />
						<RequestButton label="Terminei" variant="secondary" onPress={() => act("done")} />
						<RequestButton label="Assumir" onPress={() => act("takeover")} />
					</View>
				</>
			) : null}
		</RequestShell>
	);
}
