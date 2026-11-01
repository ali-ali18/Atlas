import { useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChatCardError } from "@/components/ui/chat-card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { checkServer } from "@/lib/server-check";
import { normalizeServerUrl } from "@/lib/server-url";
import { loadServerUrl, saveServerUrl } from "@/lib/server-store";

export default function ConnectionScreen() {
	const router = useRouter();
	const [value, setValue] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		void loadServerUrl().then((saved) => {
			if (saved) setValue(saved);
		});
	}, []);

	async function connect() {
		if (busy) return;
		const normalized = normalizeServerUrl(value, { dev: __DEV__ });
		if (!normalized.ok) {
			setError(normalized.error);
			return;
		}
		setError(null);
		setBusy(true);
		const check = await checkServer(normalized.url);
		if (!check.ok) {
			setBusy(false);
			setError(check.error);
			return;
		}
		try {
			await saveServerUrl(normalized.url);
		} catch {
			setBusy(false);
			setError("Não consegui guardar o endereço neste aparelho. Tente de novo.");
			return;
		}
		setValue(normalized.url);
		setBusy(false);
		router.push("/login");
	}

	return (
		<Screen className="justify-center">
			<View className="gap-2">
				<Text variant="title">Conectar ao Atlas</Text>
				<Text variant="muted">Informe o endereço do servidor do seu Atlas para começar.</Text>
			</View>
			<Card>
				<Text variant="caption">Endereço do servidor</Text>
				<Input
					value={value}
					onChangeText={(text) => {
						setValue(text);
						if (error) setError(null);
					}}
					placeholder="https://atlas.suaempresa.com"
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
					inputMode="url"
					returnKeyType="go"
					onSubmitEditing={connect}
					editable={!busy}
					invalid={Boolean(error)}
					accessibilityLabel="Endereço do servidor"
				/>
				{error ? <ChatCardError>{error}</ChatCardError> : null}
				<Button size="lg" onPress={connect} disabled={busy || !value.trim()}>
					{busy ? <Spinner tone="primary-foreground" /> : null}
					<Text>{busy ? "Conectando…" : "Conectar"}</Text>
				</Button>
			</Card>
		</Screen>
	);
}
