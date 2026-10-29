"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CameraIcon, KeyRoundIcon, Loader2Icon, LogOutIcon, MailIcon, Trash2Icon, UserIcon } from "lucide-react";
import { PROFILE_NAME_MAX } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@workspace/ui/components/sheet";
import { authClient } from "@/lib/auth-client";
import { checkPickedFile, prepareProfileImage } from "@/lib/profile-image";
import { removeProfileImage, saveProfileImage, saveProfileName } from "@/lib/profile-api";
import { signOutAndRedirect } from "@/lib/sign-out";
import { nameDraftState } from "../account-profile-state";
import { UserAvatar } from "@workspace/ui/components/gradient-avatar";
import { SettingRow, SettingsGroup } from "../setting-row";

const SAVE_FAILED = "Não foi possível salvar. Tente novamente.";

/** Valor somente leitura na ponta direita da linha (o e-mail vem da sessão). */
function ReadOnlyValue({ id, children }: { id: string; children: string }) {
	return (
		<span className="max-w-full truncate text-body text-muted-foreground" id={id}>
			{children || "—"}
		</span>
	);
}

export type ProfileEditing = {
	image: string | null;
	/** Salva o nome; rejeita com a mensagem para mostrar. */
	onSaveName: (name: string) => Promise<void>;
	/** Recebe o arquivo escolhido (galeria/câmera); rejeita com a mensagem para mostrar. */
	onPickPhoto: (file: File) => Promise<void>;
	onRemovePhoto: () => Promise<void>;
};

/** Toque no avatar: sem foto abre o seletor de arquivo; com foto abre as ações (trocar/remover). */
export function avatarPressAction(hasImage: boolean): "pick" | "menu" {
	return hasImage ? "menu" : "pick";
}

/** Ações da foto atual: trocar, remover (destrutivo) e cancelar. */
export function PhotoActionsList({
	onReplace,
	onRemove,
	onCancel,
}: {
	onReplace: () => void;
	onRemove: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 px-4 pb-4" data-slot="photo-actions">
			<Button onClick={onReplace} variant="outline">
				<CameraIcon aria-hidden data-icon="inline-start" /> Trocar foto
			</Button>
			<Button onClick={onRemove} variant="destructive">
				<Trash2Icon aria-hidden data-icon="inline-start" /> Remover foto
			</Button>
			<Button onClick={onCancel} variant="ghost">
				Cancelar
			</Button>
		</div>
	);
}

/** O avatar é o controle: selo de câmera indica que dá para tocar; um loading gira sobre ele durante o envio. */
export function PhotoAvatarButton({
	hasImage,
	busy,
	onPress,
	children,
}: {
	hasImage: boolean;
	busy: boolean;
	onPress: () => void;
	children: ReactNode;
}) {
	return (
		<button
			aria-busy={busy || undefined}
			aria-label={hasImage ? "Alterar foto de perfil" : "Adicionar foto de perfil"}
			className="relative size-12 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
			data-slot="photo-avatar-button"
			disabled={busy}
			onClick={onPress}
			type="button"
		>
			{children}
			{busy ? (
				<span
					className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white"
					data-slot="photo-avatar-loading"
				>
					<Loader2Icon aria-hidden className="size-5 animate-spin" />
				</span>
			) : (
				<span
					aria-hidden
					className="absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full border border-background bg-secondary text-secondary-foreground"
					data-slot="photo-avatar-badge"
				>
					<CameraIcon className="size-2.5" />
				</span>
			)}
		</button>
	);
}

function PhotoRow({ editing, name, email }: { editing: ProfileEditing; name: string; email: string }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);

	async function run(task: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await task();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : SAVE_FAILED);
		} finally {
			setBusy(false);
		}
	}

	return (
		<SettingRow
			caption={
				error ? (
					<p className="text-xs text-destructive" role="alert">
						{error}
					</p>
				) : null
			}
			control="inline"
			description="Toque na foto para escolher da galeria ou da câmera."
			icon={CameraIcon}
			label="Foto"
		>
			<PhotoAvatarButton
				busy={busy}
				hasImage={Boolean(editing.image)}
				onPress={() => (avatarPressAction(Boolean(editing.image)) === "pick" ? inputRef.current?.click() : setMenuOpen(true))}
			>
				<UserAvatar email={email} image={editing.image} name={name} seed={email || name} size={48} />
			</PhotoAvatarButton>
			<input
				accept="image/*"
				aria-label="Escolher foto de perfil"
				className="sr-only"
				data-slot="profile-photo-input"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void run(() => editing.onPickPhoto(file));
				}}
				ref={inputRef}
				tabIndex={-1}
				type="file"
			/>
			<Sheet onOpenChange={setMenuOpen} open={menuOpen}>
				<SheetContent className="mx-auto gap-0 sm:max-w-sm sm:rounded-t-2xl" data-slot="photo-actions-sheet" showCloseButton={false} side="bottom">
					<SheetHeader>
						<SheetTitle>Foto de perfil</SheetTitle>
						<SheetDescription>Troque por outra foto ou remova a atual.</SheetDescription>
					</SheetHeader>
					<PhotoActionsList
						onCancel={() => setMenuOpen(false)}
						onRemove={() => {
							setMenuOpen(false);
							void run(editing.onRemovePhoto);
						}}
						onReplace={() => {
							setMenuOpen(false);
							inputRef.current?.click();
						}}
					/>
				</SheetContent>
			</Sheet>
		</SettingRow>
	);
}

function NameRow({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }) {
	const [draft, setDraft] = useState(name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	// A sessão chega depois (ou muda em outra aba): sincroniza enquanto não há edição em curso.
	const lastSaved = useRef(name);
	useEffect(() => {
		setDraft((current) => (current === lastSaved.current ? name : current));
		lastSaved.current = name;
	}, [name]);

	const state = nameDraftState(draft, name);

	async function save() {
		if (!state.value || !state.dirty || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSave(state.value);
			setDraft(state.value);
			setSaved(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : SAVE_FAILED);
		} finally {
			setBusy(false);
		}
	}

	const message = error ?? (state.dirty ? state.error : null);
	return (
		<SettingRow
			caption={
				message ? (
					<p className="text-xs text-destructive" role="alert">
						{message}
					</p>
				) : saved && !state.dirty ? (
					<p className="text-xs text-muted-foreground">Salvo</p>
				) : null
			}
			control="inline"
			description="Como você aparece no app."
			htmlFor="settings-account-name"
			icon={UserIcon}
			label="Nome"
		>
			<Input
				aria-invalid={message ? true : undefined}
				autoComplete="name"
				className="h-8 w-44 text-body"
				id="settings-account-name"
				maxLength={PROFILE_NAME_MAX + 20}
				onChange={(event) => {
					setDraft(event.target.value);
					setSaved(false);
					setError(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void save();
					}
				}}
				placeholder="Seu nome"
				value={draft}
			/>
			{state.dirty ? (
				<Button disabled={busy || !state.value} onClick={() => void save()} size="sm">
					{busy ? "Salvando…" : "Salvar"}
				</Button>
			) : null}
		</SettingRow>
	);
}

/** Grupo Conta: foto e nome (editáveis), e-mail (da sessão) e Sair. */
export function AccountSettingsView({
	name,
	email,
	editing,
	onSignOut,
	signingOut = false,
	signOutError,
	isVisible = () => true,
}: {
	name: string;
	email: string;
	editing: ProfileEditing;
	onSignOut: () => void;
	signingOut?: boolean;
	signOutError?: string | null;
	isVisible?: (itemId: string) => boolean;
}) {
	return (
		<SettingsGroup title="Conta">
			{isVisible("conta.foto") ? <PhotoRow editing={editing} email={email} name={name} /> : null}
			{isVisible("conta.nome") ? <NameRow name={name} onSave={editing.onSaveName} /> : null}
			{isVisible("conta.email") ? (
				<SettingRow control="inline" htmlFor="settings-account-email" icon={MailIcon} label="E-mail">
					<ReadOnlyValue id="settings-account-email">{email}</ReadOnlyValue>
				</SettingRow>
			) : null}
			{isVisible("conta.sair") ? (
				<SettingRow
					caption={
						signOutError ? (
							<p className="text-xs text-destructive" role="alert">
								{signOutError}
							</p>
						) : null
					}
					control="inline"
					description="Encerra a sessão neste navegador."
					icon={KeyRoundIcon}
					label="Sessão"
				>
					<Button disabled={signingOut} onClick={onSignOut} size="sm" variant="outline">
						<LogOutIcon aria-hidden data-icon="inline-start" /> Sair
					</Button>
				</SettingRow>
			) : null}
		</SettingsGroup>
	);
}

export function AccountSettings({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	const { data: session } = authClient.useSession();
	const [signingOut, setSigningOut] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function signOut() {
		setSigningOut(true);
		setError(null);
		const failure = await signOutAndRedirect();
		if (failure) {
			setError(failure);
			setSigningOut(false);
		}
	}

	const editing: ProfileEditing = {
		image: session?.user.image ?? null,
		onSaveName: async (name) => {
			await saveProfileName(name);
		},
		onPickPhoto: async (file) => {
			const check = checkPickedFile(file);
			if (!check.ok) throw new Error(check.error);
			let image: string;
			try {
				image = await prepareProfileImage(file);
			} catch {
				throw new Error("Não foi possível ler essa foto. Tente outra.");
			}
			await saveProfileImage(image);
		},
		onRemovePhoto: async () => {
			await removeProfileImage();
		},
	};

	return (
		<AccountSettingsView
			editing={editing}
			email={session?.user.email ?? ""}
			isVisible={isVisible}
			name={session?.user.name ?? ""}
			onSignOut={() => void signOut()}
			signOutError={error}
			signingOut={signingOut}
		/>
	);
}
