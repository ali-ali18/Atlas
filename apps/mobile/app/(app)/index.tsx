import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Screen } from "@/components/screen";
import { useAtlasSession } from "@/lib/atlas-session";

/** O avatar feliz pula uma vez (o clipe dura 3,7 s) e volta ao normal. */
const HAPPY_MS = 4500;

// PLACEHOLDER da home (rota "/"). A lista de conversas de verdade substitui esta tela; o "Sair" passa para o avatar
// do topo. Até lá fica um "Sair" discreto.
export default function HomeScreen() {
	const { email, signOut, justSignedIn, consumeJustSignedIn } = useAtlasSession();
	const [celebrating, setCelebrating] = React.useState(justSignedIn);
	const [leaving, setLeaving] = React.useState(false);

	React.useEffect(() => {
		if (!justSignedIn) return;
		consumeJustSignedIn();
		const timer = setTimeout(() => setCelebrating(false), HAPPY_MS);
		return () => clearTimeout(timer);
	}, [justSignedIn, consumeJustSignedIn]);

	async function leave() {
		if (leaving) return;
		setLeaving(true);
		await signOut();
	}

	return (
		<Screen className="justify-center">
			<View className="items-center gap-3">
				<Avatar ariaLabel="Avatar do Atlas Agent" size={102} mood={celebrating ? "happy" : "neutral"} />
				{email ? <Text variant="muted" className="text-center text-sm">{email}</Text> : null}
				<Button variant="ghost" size="sm" onPress={leave} disabled={leaving}>
					<Text>Sair</Text>
				</Button>
			</View>
		</Screen>
	);
}
