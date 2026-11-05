import * as React from "react";
import { ActionSheet } from "@/components/ui/action-sheet";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { NavRow } from "./settings-rows";

type Pending = "server" | "signOut" | null;

const COPY = {
	signOut: { question: "Sair da conta? Você precisa entrar de novo para voltar aos seus bots.", confirm: "Sair" },
	server: { question: "Trocar de servidor? Você sai da conta e escolhe outro endereço.", confirm: "Trocar servidor" },
} as const;

/** "Trocar servidor" e "Sair" (vermelho), os dois com confirmação antes de agir. */
export function SessionGroup() {
	const { signOut, changeServer } = useAtlasSession();
	const [pending, setPending] = React.useState<Pending>(null);
	const copy = pending ? COPY[pending] : null;
	const cancel = () => setPending(null);
	const confirm = () => {
		const action = pending;
		setPending(null);
		if (action === "signOut") void signOut();
		else if (action === "server") void changeServer();
	};
	return (
		<>
			<SurfaceGroup>
				<NavRow title="Trocar servidor" onPress={() => setPending("server")} />
			</SurfaceGroup>
			<SurfaceGroup className="mt-5">
				<NavRow title="Sair" tone="destructive" chevron={false} onPress={() => setPending("signOut")} />
			</SurfaceGroup>
			<ActionSheet
				visible={pending !== null}
				onClose={cancel}
				header={<Text className="px-5 pb-3 text-center text-control text-muted-foreground">{copy?.question ?? ""}</Text>}
				groups={[
					[{ key: "confirm", label: copy?.confirm ?? "Confirmar", tone: "destructive", onPress: confirm }],
					[{ key: "cancel", label: "Cancelar", onPress: cancel }],
				]}
			/>
		</>
	);
}
