import * as React from "react";
import { Image, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { initialsOf } from "@/lib/home-list";
import { ThemedModalRoot } from "./themed-modal";

type UserProps = { name: string | null; email: string | null; image: string | null };

function UserAvatar({ name, email, image }: UserProps) {
	const [broken, setBroken] = React.useState(false);
	return (
		<View className="size-11 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary">
			{image && !broken ? (
				<Image source={{ uri: image }} onError={() => setBroken(true)} style={{ width: 44, height: 44 }} accessibilityIgnoresInvertColors />
			) : (
				<Text className="text-control font-semibold">{initialsOf(name, email)}</Text>
			)}
		</View>
	);
}

/** Menu simples da conta: "Sair" e "Trocar servidor". */
function UserMenu({ open, email, onClose, onSignOut, onChangeServer }: { open: boolean; email: string | null; onClose: () => void; onSignOut: () => void; onChangeServer: () => void }) {
	const insets = useSafeAreaInsets();
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
			<Pressable accessibilityLabel="Fechar menu" onPress={onClose} className="flex-1">
				<View className="ml-5 w-64 overflow-hidden rounded-card border border-border bg-popover" style={{ marginTop: insets.top + 8 + 44 + 8 }}>
					{email ? (
						<Text numberOfLines={1} className="px-4 pb-2 pt-3 text-body text-muted-foreground">
							{email}
						</Text>
					) : null}
					<Pressable role="menuitem" onPress={onSignOut} className="min-h-11 justify-center px-4 active:bg-muted/60">
						<Text className="text-control">Sair</Text>
					</Pressable>
					<Pressable role="menuitem" onPress={onChangeServer} className="min-h-11 justify-center px-4 active:bg-muted/60">
						<Text className="text-control">Trocar servidor</Text>
					</Pressable>
				</View>
			</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}

/** Topo da home: foto da conta (abre o menu) à esquerda e o "+" redondo à direita. */
export function HomeHeader({ user, onNew, onSignOut, onChangeServer }: { user: UserProps; onNew: () => void; onSignOut: () => void; onChangeServer: () => void }) {
	const [menu, setMenu] = React.useState(false);
	return (
		<View className="flex-row items-center justify-between px-5 pb-2 pt-2">
			<Pressable role="button" accessibilityLabel="Conta" accessibilityState={{ expanded: menu }} onPress={() => setMenu(true)} className="active:opacity-70">
				<UserAvatar {...user} />
			</Pressable>
			<Button size="icon" variant="secondary" accessibilityLabel="Novo chat" className="border-border" onPress={onNew}>
				<PlusIcon />
			</Button>
			<UserMenu
				open={menu}
				email={user.email}
				onClose={() => setMenu(false)}
				onSignOut={() => {
					setMenu(false);
					onSignOut();
				}}
				onChangeServer={() => {
					setMenu(false);
					onChangeServer();
				}}
			/>
		</View>
	);
}
