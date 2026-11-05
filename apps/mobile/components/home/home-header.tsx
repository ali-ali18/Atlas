import { useRouter } from "expo-router";
import * as React from "react";
import { Pressable, View } from "react-native";
import { PlusIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { type UserProps, UserAvatar } from "./user-avatar";

/** Topo da home: foto da conta (abre as Configurações, tela cheia) à esquerda e o "+" redondo à direita. */
export function HomeHeader({ user, onNew }: { user: UserProps; onNew: () => void }) {
	const router = useRouter();
	return (
		<View className="flex-row items-center justify-between px-6 pb-2 pt-2">
			<Pressable role="button" accessibilityLabel="Configurações" onPress={() => router.push("/settings" as never)} className="active:opacity-70">
				<UserAvatar {...user} />
			</Pressable>
			<ChromeButton size="md" label="Novo bot" onPress={onNew}>
				<PlusIcon />
			</ChromeButton>
		</View>
	);
}
