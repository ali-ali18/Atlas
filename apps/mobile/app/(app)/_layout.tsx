import { Stack } from "expo-router";

// Grupo das telas de quem já entrou (home, conversas, ...). O `AccessGate` em app/_layout.tsx só deixa chegar aqui
// com sessão e depois do carregamento.
export default function AppLayout() {
	return <Stack screenOptions={{ headerShown: false, animation: "fade" }} />;
}
