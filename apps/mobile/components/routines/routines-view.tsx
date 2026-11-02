import type { RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { groupRoutines } from "@/lib/routine-summary";
import { RoutineCard } from "./routine-card";
import { RoutineGroup } from "./routine-group";

export type RoutinesViewProps = {
	routines: readonly RoutineRecord[];
	groups: readonly RoutineGroupRecord[];
	/** Cor do bot (interruptores ligados). */
	accent: string;
	loading?: boolean;
	/** Frase de erro já amigável, ou null. */
	error?: string | null;
	/** Ids com o pedido em voo (interruptor desabilitado). */
	busyIds?: ReadonlySet<string>;
	onBack: () => void;
	onToggle: (routine: RoutineRecord, enabled: boolean) => void;
	onRetry?: () => void;
	/** "Pedir ao bot": criar e editar rotina é conversando (sem formulário no app). */
	onAskBot?: () => void;
};

const NO_BUSY: ReadonlySet<string> = new Set();

/**
 * Tela de Rotinas do bot: lista (soltas e grupos recolhíveis), cada rotina com a frase do gatilho e o interruptor de
 * pausar/retomar. Só desenho e estados (carregando, erro, vazio); os dados e as ações vêm de quem chama.
 */
export function RoutinesView({ routines, groups, accent, loading = false, error = null, busyIds = NO_BUSY, onBack, onToggle, onRetry, onAskBot }: RoutinesViewProps) {
	const entries = React.useMemo(() => groupRoutines(routines, groups), [routines, groups]);
	let body: React.ReactNode;
	if (loading && routines.length === 0) {
		body = (
			<View className="items-center pt-24">
				<Spinner label="Carregando rotinas" />
			</View>
		);
	} else if (error && routines.length === 0) {
		body = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{error}
				</Text>
				{onRetry ? (
					<Button variant="secondary" onPress={onRetry}>
						<Text>Tentar de novo</Text>
					</Button>
				) : null}
			</View>
		);
	} else if (entries.length === 0) {
		body = (
			<View className="items-center gap-4 px-8 pt-20">
				<Text variant="muted" className="text-center text-control">
					Rotinas são tarefas recorrentes que este bot executa em um agendamento.
				</Text>
				{onAskBot ? (
					<Button variant="secondary" onPress={onAskBot}>
						<Text>Pedir uma rotina ao bot</Text>
					</Button>
				) : null}
			</View>
		);
	} else {
		body = (
			<>
				{error ? <Text className="px-1 text-caption text-muted-foreground">{error}</Text> : null}
				{entries.map((entry) =>
					entry.kind === "group" ? (
						<RoutineGroup key={`g-${entry.group.id}`} group={entry.group} routines={entry.routines} accent={accent} busyIds={busyIds} onToggle={onToggle} />
					) : (
						<RoutineCard key={entry.routine.id} routine={entry.routine} accent={accent} busy={busyIds.has(entry.routine.id)} onToggle={onToggle} />
					),
				)}
				{onAskBot ? (
					<Button variant="secondary" className="mt-2 w-full" onPress={onAskBot}>
						<Text>Pedir uma rotina ao bot</Text>
					</Button>
				) : null}
			</>
		);
	}
	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center gap-3 px-4 pt-1.5">
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<Text className="text-xl font-semibold">Rotinas</Text>
			</View>
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-6">{body}</ScrollView>
		</SafeAreaView>
	);
}
