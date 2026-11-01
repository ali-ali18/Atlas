import { useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { Screen } from "@/components/screen";
import { SharedProof } from "@/components/shared-proof";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { loadServerUrl } from "@/lib/server-store";

export default function LoginScreen() {
	const router = useRouter();
	const [server, setServer] = React.useState<string | null>(null);

	React.useEffect(() => {
		void loadServerUrl().then(setServer);
	}, []);

	return (
		<Screen className="justify-center">
			<View className="gap-2">
				<Text variant="title">Entrar</Text>
				<Text variant="muted">{server ? `Servidor: ${server}` : "Escolha como entrar na sua conta."}</Text>
			</View>
			<Card>
				<Button size="lg" disabled accessibilityLabel="Entrar com Google, em breve">
					<Text>Entrar com Google</Text>
					<Badge variant="secondary">em breve</Badge>
				</Button>
				<Button size="lg" variant="secondary" disabled accessibilityLabel="Entrar com e-mail, em breve">
					<Text>Entrar com e-mail</Text>
					<Badge variant="outline">em breve</Badge>
				</Button>
			</Card>
			<SharedProof />
			<View className="gap-1">
				<Button variant="ghost" onPress={() => router.push("/syncing")}>
					<Text>Ver prévia da sincronização</Text>
				</Button>
				<Button variant="ghost" onPress={() => router.back()}>
					<Text>Trocar servidor</Text>
				</Button>
			</View>
		</Screen>
	);
}
