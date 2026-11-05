import { validateProfileName } from "@workspace/shared";
import { useRouter } from "expo-router";
import * as React from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { DoneButton } from "@/components/bot/done-button";
import { UserAvatar } from "@/components/home/user-avatar";
import { CameraIcon } from "@/components/icons";
import { ChromeInput } from "@/components/ui/chrome-input";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { isUnauthorized } from "@/lib/chat-api";
import { pickProfilePhoto } from "@/lib/profile-photo";
import { refreshSession } from "@/lib/session-refresh";
import { removeProfileImage, saveProfileImage, saveProfileName } from "@/lib/settings-api";
import { friendlyError } from "@/lib/settings-format";
import { NavRow, SectionLabel } from "./settings-rows";

/** Perfil: trocar ou remover a foto (galeria com recorte quadrado), editar o nome; o e-mail é só leitura (vem do login). */
export function ProfileView() {
	const router = useRouter();
	const { name, email, image, apiFetch, client, signOut } = useAtlasSession();
	const [draft, setDraft] = React.useState(name ?? "");
	// Foto mostrada já ao escolher (otimista); `undefined` = a da sessão.
	const [photo, setPhoto] = React.useState<string | null | undefined>(undefined);
	const [busy, setBusy] = React.useState<"photo" | "name" | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const shownPhoto = photo === undefined ? image : photo;

	const check = validateProfileName(draft);
	const changed = check.ok && check.name !== (name ?? "").trim();
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/settings" as never));

	const fail = (reason: unknown) => {
		if (isUnauthorized(reason)) void signOut();
		else setError(friendlyError(reason));
	};

	const savePhoto = async () => {
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

	const saveName = async () => {
		if (!check.ok || !changed || busy) return;
		setError(null);
		setBusy("name");
		try {
			await saveProfileName(apiFetch, check.name);
			refreshSession(client);
			goBack();
		} catch (reason) {
			fail(reason);
			setBusy(null);
		}
	};

	return (
		<ScreenFrame>
			<ScreenHeader title="Perfil" onBack={goBack} right={<DoneButton enabled={changed} busy={busy === "name"} onPress={() => void saveName()} />} />
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pb-12 pt-4">
				<Pressable role="button" accessibilityLabel="Trocar foto" disabled={busy !== null} onPress={() => void savePhoto()} className="size-28 items-center justify-center self-center active:opacity-80">
					<UserAvatar name={draft || name} email={email} image={shownPhoto} size={112} />
					<View className="absolute inset-0 items-center justify-center">{busy === "photo" ? <Spinner label="Enviando a foto" size="large" tone="foreground" /> : null}</View>
					<View className="absolute bottom-0 right-0 size-9 items-center justify-center rounded-full bg-foreground">
						<CameraIcon size={18} tone="background" />
					</View>
				</Pressable>
				<SurfaceGroup className="mt-6">
					<NavRow title="Trocar foto" disabled={busy !== null} onPress={() => void savePhoto()} />
					{shownPhoto ? <NavRow title="Remover foto" tone="destructive" chevron={false} disabled={busy !== null} onPress={() => void removePhoto()} /> : null}
				</SurfaceGroup>
				<SectionLabel>Nome</SectionLabel>
				<ChromeInput accessibilityLabel="Nome" value={draft} onChangeText={setDraft} maxLength={80} autoCapitalize="words" invalid={!check.ok && draft.length > 0} editable={busy !== "name"} />
				{!check.ok && draft.length > 0 ? (
					<Text className="px-4 pt-2 text-body text-destructive" accessibilityRole="alert">
						{check.error}
					</Text>
				) : null}
				<SectionLabel>E-mail</SectionLabel>
				<SurfaceGroup>
					<NavRow title={email ?? "—"} chevron={false} />
				</SurfaceGroup>
				<Text variant="muted" className="px-5 pt-2 text-body">
					O e-mail é o do seu login e não muda por aqui.
				</Text>
				{error ? (
					<Text className="px-5 pt-4 text-control text-destructive" accessibilityRole="alert">
						{error}
					</Text>
				) : null}
			</ScrollView>
		</ScreenFrame>
	);
}
