import { useRouter } from "expo-router";
import * as React from "react";
import { Linking, Pressable, View } from "react-native";
import { UserAvatar } from "@/components/home/user-avatar";
import { ActionSheet } from "@/components/ui/action-sheet";
import { FloatingHeaderScroll } from "@/components/ui/floating-header-scroll";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { isUnauthorized } from "@/lib/chat-api";
import { pickProfilePhoto } from "@/lib/profile-photo";
import { refreshSession } from "@/lib/session-refresh";
import { removeProfileImage, saveProfileImage, saveProfileName } from "@/lib/settings-api";
import { friendlyError } from "@/lib/settings-format";
import { ProfileNameSheet } from "./profile-name-sheet";
import { SessionGroup } from "./session-group";

/**
 * Conta (Configurações > Conta): cartão do perfil (avatar abre Trocar/Remover foto, nome abre a edição, e-mail só leitura),
 * depois Trocar servidor e Sair com confirmação. Nome e foto salvam na hora e a home atualiza pela sessão.
 */
export function AccountView() {
	const router = useRouter();
	const { name, email, image, apiFetch, client, signOut } = useAtlasSession();
	// Foto mostrada já ao escolher (otimista); `undefined` = a da sessão.
	const [photo, setPhoto] = React.useState<string | null | undefined>(undefined);
	const [busy, setBusy] = React.useState<"photo" | "name" | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [photoMenu, setPhotoMenu] = React.useState(false);
	const [editingName, setEditingName] = React.useState(false);
	const shownPhoto = photo === undefined ? image : photo;
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/settings" as never));

	const fail = (reason: unknown) => {
		if (isUnauthorized(reason)) void signOut();
		else setError(friendlyError(reason));
	};

	const savePhoto = async () => {
		setPhotoMenu(false);
		setError(null);
		setBusy("photo");
		try {
			const outcome = await pickProfilePhoto();
			if (outcome.kind === "denied") {
				setError("Sem acesso às suas fotos. Libere nas configurações do aparelho.");
				void Linking.openSettings().catch(() => undefined);
			} else if (outcome.kind === "failed") setError("Não consegui preparar essa foto. Tente outra.");
			else if (outcome.kind === "ready") {
				const previous = shownPhoto;
				setPhoto(outcome.dataUrl);
				try {
					await saveProfileImage(apiFetch, outcome.dataUrl);
					refreshSession(client);
				} catch (reason) {
					setPhoto(previous);
					fail(reason);
				}
			}
		} finally {
			setBusy(null);
		}
	};

	const removePhoto = async () => {
		setPhotoMenu(false);
		setError(null);
		setBusy("photo");
		const previous = shownPhoto;
		setPhoto(null);
		try {
			await removeProfileImage(apiFetch);
			refreshSession(client);
		} catch (reason) {
			setPhoto(previous);
			fail(reason);
		} finally {
			setBusy(null);
		}
	};

	const saveName = async (next: string) => {
		setError(null);
		setBusy("name");
		try {
			await saveProfileName(apiFetch, next);
			refreshSession(client);
		} catch (reason) {
			fail(reason);
		} finally {
			setEditingName(false);
			setBusy(null);
		}
	};

	return (
		<ScreenFrame edges={["bottom", "left", "right"]}>
			<FloatingHeaderScroll header={<ScreenHeader title="Conta" align="left" onBack={goBack} />} keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pb-12">
				<SurfaceGroup>
					<SurfaceRow className="min-h-[88px] py-4">
						<Pressable role="button" accessibilityLabel="Foto do perfil" disabled={busy !== null} onPress={() => setPhotoMenu(true)} className="size-14 items-center justify-center active:opacity-80">
							<UserAvatar name={name} email={email} image={shownPhoto} size={56} />
							{busy === "photo" ? (
								<View className="absolute inset-0 items-center justify-center">
									<Spinner label="Enviando a foto" tone="foreground" />
								</View>
							) : null}
						</Pressable>
						<View className="min-w-0 flex-1">
							<Pressable role="button" accessibilityLabel="Editar nome" disabled={busy !== null} onPress={() => setEditingName(true)} className="active:opacity-70">
								<Text numberOfLines={1} className="text-lg">
									{name?.trim() || "Sem nome"}
								</Text>
							</Pressable>
							{email ? (
								<Text variant="muted" numberOfLines={1} className="text-body">
									{email}
								</Text>
							) : null}
						</View>
					</SurfaceRow>
				</SurfaceGroup>
				{error ? (
					<Text className="px-5 pt-3 text-control text-destructive" accessibilityRole="alert">
						{error}
					</Text>
				) : null}
				<View className="mt-5">
					<SessionGroup />
				</View>
			</FloatingHeaderScroll>
			<ActionSheet
				visible={photoMenu}
				onClose={() => setPhotoMenu(false)}
				groups={[
					[
						{ key: "change", label: "Trocar foto", onPress: () => void savePhoto() },
						...(shownPhoto ? [{ key: "remove", label: "Remover foto", tone: "destructive" as const, onPress: () => void removePhoto() }] : []),
					],
					[{ key: "cancel", label: "Cancelar", onPress: () => setPhotoMenu(false) }],
				]}
			/>
			<ProfileNameSheet visible={editingName} currentName={name ?? ""} email={email} saving={busy === "name"} onClose={() => setEditingName(false)} onSave={(next) => void saveName(next)} />
		</ScreenFrame>
	);
}
