import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { ACTION_LABEL, type AppAction } from "@/lib/apps";
import { useSurfaces } from "@/lib/use-surfaces";

/**
 * Botão de ação do aplicativo, o mesmo na linha da lista e no detalhe: "Conectar" (secundário), "Autorizar" (azul de
 * ação do app), "Conectado" (apagado) e "Em breve"/"Indisponível" (desabilitados). Na lista ele só leva ao detalhe; é no
 * detalhe que a conexão começa (`busy` mostra o giro).
 */
export function AppActionButton({ action, name, onPress, size = "sm", busy = false, disabled = false, className }: { action: AppAction; name: string; onPress?: () => void; size?: "sm" | "lg"; busy?: boolean; disabled?: boolean; className?: string }) {
	const surfaces = useSurfaces();
	const inert = action === "soon" || action === "unavailable";
	const label = ACTION_LABEL[action];
	const accessibilityLabel = `${label}: ${name}`;
	if (action === "authorize") {
		return (
			<Button size={size} variant="ghost" accessibilityLabel={accessibilityLabel} disabled={disabled || busy} onPress={onPress} style={{ backgroundColor: surfaces.link }} className={className}>
				{busy ? <Spinner tone="primary-foreground" /> : null}
				<Text className="text-white">{label}</Text>
			</Button>
		);
	}
	return (
		<Button size={size} variant="secondary" accessibilityLabel={accessibilityLabel} disabled={inert || disabled || busy} onPress={onPress} style={{ backgroundColor: surfaces.chromeFill, borderColor: surfaces.chromeEdge }} className={action === "connected" ? `opacity-60 ${className ?? ""}` : className}>
			{busy ? <Spinner /> : null}
			<Text>{label}</Text>
		</Button>
	);
}
