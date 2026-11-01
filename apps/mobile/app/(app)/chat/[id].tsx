import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { useHomeData } from "@/lib/home-data";

/** Placeholder: o chat ao vivo é a próxima etapa. Já recebe o bot tocado na home. */
export default function ChatScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot } = useHomeData();
	const bot = snapshot?.bots.find((item) => item.id === id);
	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center gap-2 px-3 pt-2">
				<Pressable role="button" accessibilityLabel="Voltar" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} className="size-11 items-center justify-center rounded-full active:bg-muted/60">
					<ChevronLeftIcon />
				</Pressable>
				<Text numberOfLines={1} className="min-w-0 flex-1 text-control font-semibold">
					{bot?.name ?? "Chat"}
				</Text>
			</View>
			<View className="flex-1 items-center justify-center px-8">
				<Text variant="muted" className="text-center text-control">
					Chat em breve
				</Text>
			</View>
		</SafeAreaView>
	);
}
