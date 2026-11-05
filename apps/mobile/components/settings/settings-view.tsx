import { useRouter } from "expo-router";
import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { UserAvatar } from "@/components/home/user-avatar";
import { ChevronRightIcon, CloseIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { useAccountSettings } from "@/lib/use-account-settings";
import { AppSettingsGroup } from "./app-settings-group";
import { BotSettingsGroup } from "./bot-settings-group";
import { SessionGroup } from "./session-group";
import { SectionLabel, NavRow } from "./settings-rows";
import { SettingsFooter } from "./settings-footer";

/** Aviso amigável de uma escrita que não foi aceita (o valor já voltou ao que era); toque para dispensar. */
function NoticeBar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
	return (
		<Pressable role="alert" accessibilityLabel={`${message} Toque para dispensar.`} onPress={onDismiss} className="mb-4 rounded-card bg-destructive/10 px-4 py-3 active:opacity-70">
			<Text className="text-control text-destructive">{message}</Text>
		</Pressable>
	);
}

/** Configurações: tela cheia aberta pelo avatar da home. Cada linha salva na hora; o que falha volta e avisa. */
export function SettingsView() {
	const router = useRouter();
	const { name, email, image } = useAtlasSession();
	const state = useAccountSettings();
	const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
	return (
		<ScreenFrame>
			<View className="px-4 pb-2 pt-1.5">
				<ChromeButton label="Fechar" onPress={close}>
					<CloseIcon size={20} tone="foreground" />
				</ChromeButton>
			</View>
			<ScrollView contentContainerClassName="px-4 pb-10 pt-4">
				{state.notice ? <NoticeBar message={state.notice} onDismiss={state.dismissNotice} /> : null}
				{state.loadFailed ? (
					<Pressable role="button" accessibilityLabel="Tentar de novo" onPress={state.reload} className="mb-4 rounded-card bg-warning/10 px-4 py-3 active:opacity-70">
						<Text className="text-control text-warning">Não consegui carregar suas configurações. Toque para tentar de novo.</Text>
					</Pressable>
				) : null}
				<SurfaceGroup>
					<SurfaceRow label="Perfil" onPress={() => router.push("/settings/profile" as never)} className="min-h-[76px] justify-between">
						<UserAvatar name={name} email={email} image={image} size={44} />
						<View className="min-w-0 flex-1">
							<Text numberOfLines={1} className="text-lg">
								{name?.trim() || email || "Perfil"}
							</Text>
							{name?.trim() && email ? (
								<Text variant="muted" numberOfLines={1} className="text-body">
									{email}
								</Text>
							) : null}
						</View>
						<ChevronRightIcon />
					</SurfaceRow>
					<NavRow title="Uso" value={state.usageSummary} onPress={() => router.push("/settings/usage" as never)} />
				</SurfaceGroup>
				<SurfaceGroup className="mt-5">
					<NavRow title="Conectar aplicativos" subtitle="Conectores e plugins" onPress={() => router.push("/apps" as never)} />
				</SurfaceGroup>
				<SectionLabel>Bot</SectionLabel>
				<BotSettingsGroup state={state} />
				<SectionLabel>App</SectionLabel>
				<AppSettingsGroup />
				<View className="mt-5">
					<SessionGroup />
				</View>
				<SettingsFooter />
			</ScrollView>
		</ScreenFrame>
	);
}
