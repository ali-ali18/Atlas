import * as React from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import { ExternalLinkIcon } from "@/components/icons";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { canSubmitKey, type AppDetail } from "@/lib/app-detail";
import { AppActionButton } from "./app-action-button";
import { AppIcon } from "./app-icon";

export type AppDetailLoad = { status: "loading" } | { status: "error"; message: string } | { status: "missing" } | { status: "ready"; detail: AppDetail };

export type AppDetailViewProps = {
	load: AppDetailLoad;
	/** Conectando/autorizando/desconectando: botões travados. */
	busy: boolean;
	/** O que está em andamento é a conexão (o botão principal mostra o giro). */
	connecting: boolean;
	/** O navegador está aberto e o app espera o login terminar. */
	waiting: boolean;
	error: string | null;
	notice: string | null;
	apiKey: string;
	onApiKey: (value: string) => void;
	onPrimary: () => void;
	confirmingDisconnect: boolean;
	onAskDisconnect: () => void;
	onCancelDisconnect: () => void;
	onDisconnect: () => void;
	onOpenHelp: (url: string) => void;
	onBack: () => void;
	onRetry: () => void;
};

/**
 * Detalhe do aplicativo: ícone grande, nome, texto, o botão principal (Conectar / Autorizar / Conectado), o campo de chave
 * quando o conector pede uma, as habilidades e "Desconectar" (com confirmação). A conexão só começa aqui.
 */
export function AppDetailView(props: AppDetailViewProps) {
	const { load, busy, connecting, waiting, error, notice, apiKey, onApiKey, onPrimary, confirmingDisconnect, onAskDisconnect, onCancelDisconnect, onDisconnect, onOpenHelp, onBack, onRetry } = props;
	let body: React.ReactNode;
	if (load.status === "loading") {
		body = (
			<View className="items-center pt-24">
				<Spinner size="large" label="Carregando" />
			</View>
		);
	} else if (load.status === "missing") {
		body = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				Não encontrei este aplicativo. Ele pode ter saído do catálogo.
			</Text>
		);
	} else if (load.status === "error") {
		body = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{load.message}
				</Text>
				<Button variant="secondary" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			</View>
		);
	} else {
		const { detail } = load;
		const keyMissing = detail.apiKey !== null && !canSubmitKey(apiKey);
		const canDisconnect = detail.disconnectIds.length > 0;
		body = (
			<ScrollView className="flex-1" contentContainerClassName="gap-6 px-5 pb-8 pt-4" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
				<View className="items-center gap-3">
					<AppIcon src={detail.icon} name={detail.name} size={88} />
					<Text accessibilityRole="header" className="text-center text-2xl font-semibold">
						{detail.name}
					</Text>
					{detail.account ? (
						<Text variant="muted" className="text-center text-control">
							{detail.account}
						</Text>
					) : null}
				</View>

				<View className="gap-3">
					{detail.apiKey ? (
						<View className="gap-2">
							<Text className="text-control font-medium">{detail.apiKey.label}</Text>
							<ChromeInput value={apiKey} onChangeText={onApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy} placeholder="Cole a chave aqui" accessibilityLabel={detail.apiKey.label} returnKeyType="done" />
							{detail.apiKey.helpUrl ? (
								<Pressable role="link" accessibilityLabel="Onde encontro a chave" onPress={() => onOpenHelp(detail.apiKey!.helpUrl)} className="flex-row items-center gap-1.5 self-start py-1 active:opacity-70">
									<ExternalLinkIcon />
									<Text variant="muted" className="text-control">
										Onde encontro a chave
									</Text>
								</Pressable>
							) : null}
						</View>
					) : null}
					<AppActionButton action={detail.action} name={detail.name} size="lg" busy={connecting} disabled={busy || keyMissing || detail.action === "connected"} onPress={onPrimary} className="self-stretch" />
					{waiting ? (
						<Text variant="muted" className="text-center text-control">
							Termine o login no navegador. Eu confirmo aqui quando acabar.
						</Text>
					) : null}
					{notice ? (
						<Text variant="muted" className="text-center text-control">
							{notice}
						</Text>
					) : null}
					{detail.note ? (
						<Text variant="muted" className="text-center text-control">
							{detail.note}
						</Text>
					) : null}
					{error ? (
						<Text variant="error" accessibilityRole="alert" className="text-center text-control">
							{error}
						</Text>
					) : null}
				</View>

				{detail.description ? <Text className="text-base leading-6 text-muted-foreground">{detail.description}</Text> : null}

				{detail.skills.length > 0 ? (
					<View className="gap-2">
						<Text accessibilityRole="header" className="text-lg font-semibold">
							Habilidades
						</Text>
						<SurfaceGroup>
							{detail.skills.map((skill) => (
								<SurfaceRow key={skill.key} className="min-h-0 items-start py-3">
									<View className="min-w-0 flex-1 gap-0.5">
										<Text className="text-control font-medium">{skill.title}</Text>
										{skill.description ? (
											<Text variant="muted" className="text-control">
												{skill.description}
											</Text>
										) : null}
									</View>
								</SurfaceRow>
							))}
						</SurfaceGroup>
					</View>
				) : null}

				{canDisconnect ? (
					<Button variant="destructive" disabled={busy} accessibilityLabel={`Desconectar ${detail.name}`} onPress={onAskDisconnect} className="self-stretch">
						<Text>Desconectar</Text>
					</Button>
				) : null}
			</ScrollView>
		);
	}
	const name = load.status === "ready" ? load.detail.name : "";
	return (
		<ScreenFrame>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<ScreenHeader onBack={onBack} />
				{body}
			</KeyboardAvoidingView>
			<ActionSheet
				visible={confirmingDisconnect}
				onClose={onCancelDisconnect}
				header={
					<Text className="px-5 pb-3 text-center text-control text-muted-foreground">
						{name ? `Desconectar ${name}? O bot deixa de usar este aplicativo até você conectar de novo.` : "Desconectar este aplicativo?"}
					</Text>
				}
				groups={[
					[{ key: "confirm", label: "Desconectar", tone: "destructive", onPress: onDisconnect }],
					[{ key: "cancel", label: "Cancelar", onPress: onCancelDisconnect }],
				]}
			/>
		</ScreenFrame>
	);
}
