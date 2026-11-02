import { useRouter } from "expo-router";
import { View } from "react-native";
import { AtSignIcon, GoogleIcon } from "@/components/icons";
import { AuthColumn, AuthDivider, AuthHeader } from "@/components/auth-layout";
import { Screen } from "@/components/screen";
import { SharedProof } from "@/components/shared-proof";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Text } from "@/components/ui/text";
import { clearServerUrl } from "@/lib/server-store";

// Textos de apps/web/lib/i18n/messages/pt-BR/login.ts (login.title, subtitle, google, or, emailLabel,
// emailPlaceholder, sendLink). Etapa 0: tudo desabilitado, com selo "em breve".
export default function LoginScreen() {
	const router = useRouter();

	async function changeServer() {
		await clearServerUrl();
		router.replace("/");
	}

	return (
		<Screen className="justify-center">
			<AuthColumn>
				<AuthHeader title="Entrar no Atlas" subtitle="Seu agente pessoal no seu servidor." />
				<View className="gap-3">
					<Button size="lg" variant="outline" className="w-full" disabled accessibilityLabel="Continuar com Google, em breve">
						<GoogleIcon />
						<Text>Continuar com Google</Text>
						<Badge variant="secondary">em breve</Badge>
					</Button>
				</View>
				<AuthDivider>ou</AuthDivider>
				<View className="gap-3">
					<InputGroup>
						<InputGroupAddon>
							<AtSignIcon />
						</InputGroupAddon>
						<InputGroupInput accessibilityLabel="E-mail" placeholder="voce@exemplo.com" editable={false} />
					</InputGroup>
					<Button size="lg" className="w-full" disabled accessibilityLabel="Enviar link de acesso, em breve">
						<Text>Enviar link de acesso</Text>
						<Badge variant="secondary">em breve</Badge>
					</Button>
				</View>
				<Button variant="ghost" size="sm" className="self-center" onPress={changeServer}>
					<Text>Trocar servidor</Text>
				</Button>
				{/* Só em desenvolvimento: prova do shared e atalho da etapa 0, não são para o usuário. */}
				{__DEV__ ? <SharedProof /> : null}
				<View className="gap-1">
					{__DEV__ ? (
						<Button variant="ghost" size="sm" onPress={() => router.push("/syncing")}>
							<Text>Ver prévia da sincronização</Text>
						</Button>
					) : null}
				</View>
			</AuthColumn>
		</Screen>
	);
}
