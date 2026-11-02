import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CheckCircleIcon, CircleXIcon, CodeIcon, FileTextIcon, GlobeIcon, TerminalIcon, WrenchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import type { RunLogStep, StepIcon } from "@/lib/run-log";
import { formatRunTime } from "@/lib/routine-run";
import { useAppColorScheme } from "@/lib/use-theme";

function Glyph({ icon }: { icon: StepIcon }) {
	switch (icon) {
		case "web":
			return <GlobeIcon size={22} />;
		case "read":
			return <FileTextIcon size={22} />;
		case "run":
			return <TerminalIcon size={22} />;
		case "code":
			return <CodeIcon size={22} />;
		default:
			return <WrenchIcon size={22} />;
	}
}

/** "10:42" no fuso do aparelho (o Registro mostra a hora do passo, não a data). */
export function stepTime(iso: string): string {
	const full = formatRunTime(iso);
	return full ? full.slice(full.indexOf(" ") + 1) : "";
}

export type RunLogViewProps = {
	/** Título da execução (a primeira tarefa). */
	title: string;
	steps: readonly RunLogStep[];
	loading?: boolean;
	error?: string | null;
	/** Registro mais antigo que o que o servidor guarda (30 dias): sem passos para mostrar. */
	expired?: boolean;
	onBack: () => void;
	onRetry?: () => void;
};

/**
 * Registro de uma execução: a linha do tempo dos passos (ícone, o que foi feito, a hora e se deu certo), num cartão único.
 * Nunca mostra comando, argumento, saída nem caminho: só a frase do passo, a hora e ok ou erro.
 */
export function RunLogView({ title, steps, loading = false, error = null, expired = false, onBack, onRetry }: RunLogViewProps) {
	const surface = routineSurface(useAppColorScheme());
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title="Registro" onBack={onBack} />
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-4">
				<Text variant="muted" numberOfLines={2} className="px-2 text-base">
					{title}
				</Text>
				{loading && steps.length === 0 ? (
					<View className="items-center pt-16">
						<Spinner label="Carregando o registro" />
					</View>
				) : error && steps.length === 0 ? (
					<View className="items-center gap-4 px-8 pt-12">
						<Text variant="muted" className="text-center text-control">
							{error}
						</Text>
						{onRetry ? (
							<Button variant="secondary" onPress={onRetry}>
								<Text>Tentar de novo</Text>
							</Button>
						) : null}
					</View>
				) : steps.length === 0 ? (
					<Text variant="muted" className="px-2 pt-8 text-center text-control">
						{expired ? "O registro desta execução já não está guardado." : "Esta execução não teve passos para mostrar."}
					</Text>
				) : (
					<View style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21, overflow: "hidden" }}>
						{steps.map((step, index) => (
							<View key={step.id} className="flex-row items-center gap-4 px-5 py-4" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
								<View className="size-8 items-center justify-center">
									<Glyph icon={step.icon} />
								</View>
								<View className="min-w-0 flex-1">
									<Text numberOfLines={2} className="text-lg">
										{step.label}
									</Text>
									<Text variant="muted" className="text-base">
										{stepTime(step.at)}
										{step.ok === false ? " · Erro" : step.ok === null ? " · Em andamento" : ""}
									</Text>
								</View>
								{step.ok === true ? <CheckCircleIcon size={22} tone="muted-foreground" /> : step.ok === false ? <CircleXIcon size={22} tone="destructive" /> : <Spinner label="Em andamento" />}
							</View>
						))}
					</View>
				)}
			</ScrollView>
		</SafeAreaView>
	);
}
