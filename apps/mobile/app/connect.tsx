import * as React from "react";
import { LinkIcon } from "@/components/icons";
import { AuthColumn, AuthHeader } from "@/components/auth-layout";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { checkServer } from "@/lib/server-check";
import { useAtlasSession } from "@/lib/atlas-session";
import { loadServerUrl } from "@/lib/server-store";
import { normalizeServerUrl } from "@/lib/server-url";

// Mesma estrutura do login do web: cabeçalho, campo em InputGroup com ícone, botão `lg` de largura total,
// erro centralizado em `text-destructive text-sm` e rodapé. O campo é o endereço do servidor, não o e-mail.
export default function ConnectionScreen() {
	const { connectServer } = useAtlasSession();
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
			await connectServer(normalized.url);
		} catch {
			setBusy(false);
			setError("Não consegui guardar o endereço neste aparelho. Tente de novo.");
			return;
		}
		setValue(normalized.url);
		setBusy(false);
		// A navegação para o Login vem do controle de acesso (app/_layout.tsx) assim que o servidor é guardado.
	}

	return (
		<Screen className="justify-center">
			<AuthColumn>
				<AuthHeader title="Conectar ao Atlas" subtitle="Seu agente pessoal no seu servidor." />
				<InputGroup invalid={Boolean(error)}>
					<InputGroupAddon>
						<LinkIcon />
					</InputGroupAddon>
					<InputGroupInput
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
						accessibilityLabel="Endereço do servidor"
					/>
				</InputGroup>
				<Button size="lg" className="w-full" onPress={connect} disabled={busy || !value.trim()}>
					{busy ? <Spinner tone="primary-foreground" /> : null}
					<Text>{busy ? "Conectando…" : "Conectar"}</Text>
				</Button>
				{error ? (
					<Text accessibilityRole="alert" variant="error" className="text-center text-sm">
						{error}
					</Text>
				) : null}
			</AuthColumn>
		</Screen>
	);
}
