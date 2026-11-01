import * as React from "react";
import { AuthColumn, AuthHeader } from "@/components/auth-layout";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";

/** O avatar feliz pula uma vez (o clipe dura 3,7 s) e volta ao normal. */
const HAPPY_MS = 4500;

// Tela provisória: a lista de conversas entra na próxima etapa.
export default function ConnectedScreen() {
	const { email, signOut, justSignedIn, consumeJustSignedIn } = useAtlasSession();
	const [happy] = React.useState(justSignedIn);
	const [celebrating, setCelebrating] = React.useState(justSignedIn);
	const [leaving, setLeaving] = React.useState(false);

	React.useEffect(() => {
		if (!happy) return;
		consumeJustSignedIn();
		const timer = setTimeout(() => setCelebrating(false), HAPPY_MS);
		return () => clearTimeout(timer);
	}, [happy, consumeJustSignedIn]);

	async function leave() {
		if (leaving) return;
		setLeaving(true);
		await signOut();
	}

	return (
		<Screen className="justify-center">
			<AuthColumn>
				<AuthHeader title="Você está dentro" subtitle={email ? `Conectado como ${email}` : "Conectado"} mood={celebrating ? "happy" : "neutral"} />
				<Button size="lg" variant="outline" className="w-full" onPress={leave} disabled={leaving}>
					{leaving ? <Spinner tone="foreground" /> : null}
					<Text>Sair</Text>
				</Button>
			</AuthColumn>
		</Screen>
	);
}
