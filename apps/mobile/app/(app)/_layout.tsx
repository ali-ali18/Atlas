import { Stack } from "expo-router";

// Grupo das telas de quem já entrou (home, conversas, ...). O `AccessGate` em app/_layout.tsx só deixa chegar aqui
// com sessão e depois do carregamento.
export default function AppLayout() {
	return (
		<Stack screenOptions={{ headerShown: false, animation: "fade" }}>
			{/* "Criar novo Bot" sobe de baixo como uma folha cheia (o "+" da home). */}
			<Stack.Screen name="new-bot" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
			{/* O catálogo de bots prontos (a grade da home) também sobe como folha cheia; o detalhe entra por cima, da direita. */}
			<Stack.Screen name="catalog/index" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
			<Stack.Screen name="catalog/[slug]" options={{ animation: "slide_from_right" }} />
			{/* Aplicativos (a grade da home): folha cheia como o catálogo; "Seus aplicativos" e o detalhe entram por cima, da direita. */}
			<Stack.Screen name="apps/index" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
			<Stack.Screen name="apps/connected" options={{ animation: "slide_from_right" }} />
			<Stack.Screen name="apps/[id]" options={{ animation: "slide_from_right" }} />
		</Stack>
	);
}
