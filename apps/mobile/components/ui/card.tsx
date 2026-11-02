import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/cn";

// O packages/ui não tem `Card` genérico (o cartão do chat é o `ChatCard`, ver chat-card.tsx).
// Este é o contêiner de formulário/seção das telas do app: raio `rounded-panel` e borda do tema.
export function Card({ className, ...props }: React.ComponentProps<typeof View>) {
	return <View className={cn("gap-3 rounded-panel border border-border bg-card p-4", className)} {...props} />;
}
