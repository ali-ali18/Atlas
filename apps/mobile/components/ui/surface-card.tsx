import * as React from "react";
import { Pressable, View, type ViewProps } from "react-native";
import { cn } from "@/lib/cn";
import { SURFACE_RADIUS } from "@/lib/surfaces";
import { useSurfaces } from "@/lib/use-surfaces";

/** Cartão padrão do app: `surface` com contorno `surfaceEdge` e raio 21. Perfil, rotinas, execuções, tabela do chat. */
export function SurfaceCard({ className, style, ...props }: ViewProps) {
	const surfaces = useSurfaces();
	return <View style={[{ backgroundColor: surfaces.surface, borderColor: surfaces.surfaceEdge, borderRadius: SURFACE_RADIUS, borderWidth: 1 }, style]} className={className} {...props} />;
}

/** Divisor de uma linha a outra: ocupa a largura toda do grupo (vai até a borda do cartão). */
export function SurfaceDivider() {
	const surfaces = useSurfaces();
	return <View style={{ height: 1, backgroundColor: surfaces.divider }} />;
}

/**
 * Grupo de linhas num cartão só: o contêiner recorta nos cantos e põe um divisor de ponta a ponta ENTRE os filhos
 * (nenhum filho desenha o próprio divisor). Linha pressionável: `SurfaceRow`.
 */
export function SurfaceGroup({ children, className, style, ...props }: ViewProps) {
	const rows = React.Children.toArray(children);
	return (
		<SurfaceCard style={[{ overflow: "hidden" }, style]} className={className} {...props}>
			{rows.map((row, index) => (
				<React.Fragment key={React.isValidElement(row) && row.key != null ? row.key : index}>
					{index > 0 ? <SurfaceDivider /> : null}
					{row}
				</React.Fragment>
			))}
		</SurfaceCard>
	);
}

/** Linha de um `SurfaceGroup`: altura mínima de toque, `px-5` e realce ao pressionar. Sem `onPress` é só uma linha. */
export function SurfaceRow({ onPress, label, className, children, radio }: { onPress?: () => void; label?: string; className?: string; children: React.ReactNode; /** Linha de uma lista de opções: papel `radio`, `checked` diz qual está escolhida. */ radio?: { checked: boolean } }) {
	const base = "min-h-14 flex-row items-center gap-4 px-5";
	if (!onPress) return <View className={cn(base, className)}>{children}</View>;
	return (
		<Pressable role={radio ? "radio" : "button"} accessibilityLabel={label} accessibilityState={radio ? { checked: radio.checked } : undefined} onPress={onPress} className={cn(base, "active:bg-foreground/10", className)}>
			{children}
		</Pressable>
	);
}
