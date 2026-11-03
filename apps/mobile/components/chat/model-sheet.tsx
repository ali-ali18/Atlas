import { effortForModel, REASONING_DEFAULT_LABEL, REASONING_EFFORT_LABELS, type ReasoningEffort } from "@workspace/shared";
import * as React from "react";
import { Pressable, View } from "react-native";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { findOption, unlistedOption, visibleOthers, type ModelOption } from "@/lib/model-catalog";
import { currentSelection, RECOMMENDED_EFFORT, type ModelChoice } from "@/lib/model-choice";
import type { ModelSelector } from "@/lib/use-model-selector";

const RECOMMENDED = "Recomendado";

/** Linha de uma lista em cartão: título, apoio opcional e o ✓ do selecionado. Divisor fino entre as linhas, como no `ActionSheet`. */
function Row({ title, hint, label, selected, onPress, first, trailing }: { title: string; hint?: string; /** Rótulo para leitor de tela (título, descrição, valor e selos); padrão: título e descrição. */ label?: string; selected?: boolean; onPress: () => void; first: boolean; trailing?: React.ReactNode }) {
	return (
		<>
			{first ? null : <View className="h-px bg-border" />}
			<Pressable role="button" accessibilityLabel={label ?? (hint ? `${title}. ${hint}` : title)} accessibilityState={{ selected: selected ?? false }} onPress={onPress} className="min-h-16 flex-row items-center gap-3 px-5 py-3 active:bg-foreground/10">
				<View className="min-w-0 flex-1">
					<Text numberOfLines={1} className="text-control">
						{title}
					</Text>
					{hint ? (
						<Text variant="caption" numberOfLines={1} className="text-body">
							{hint}
						</Text>
					) : null}
				</View>
				{trailing}
				{selected ? <CheckIcon /> : null}
			</Pressable>
		</>
	);
}

const Card = ({ children }: { children: React.ReactNode }) => <View className="overflow-hidden rounded-card bg-muted">{children}</View>;

/** O nível que a linha "Esforço" mostra: o mesmo que o servidor vai usar naquele modelo (como no web). */
function shownEffort(selection: Extract<ModelChoice, { mode: "model" }>, option: ModelOption): ReasoningEffort | undefined {
	return effortForModel(selection.effort, option.id, option.info);
}

const effortLabel = (effort: ReasoningEffort | undefined) => (effort ? REASONING_EFFORT_LABELS[effort] : REASONING_DEFAULT_LABEL);

/**
 * Folha "Selecionar modelo" (gaveta arrastável do app): modelos principais em cartões com ✓, a linha "Esforço" (só quando
 * o modelo escolhido aceita raciocínio), "Outros modelos" recolhidos e "Automático". Tudo vem do catálogo real da API.
 */
export function ModelSheet({ visible, onClose, selector }: { visible: boolean; onClose: () => void; selector: ModelSelector }) {
	const [page, setPage] = React.useState<"main" | "effort">("main");
	const [othersOpen, setOthersOpen] = React.useState(false);
	const [showAllOthers, setShowAllOthers] = React.useState(false);
	const { catalog, choice, setChoice, loadCatalog, notice } = selector;
	const data = catalog.catalog;

	React.useEffect(() => {
		if (visible) loadCatalog();
		else {
			setPage("main");
			setOthersOpen(false);
			setShowAllOthers(false);
		}
	}, [visible, loadCatalog]);

	const selection = currentSelection(choice, data?.bot ?? null);
	const unknownBot = selection.mode === "unknown" && data !== null;
	const option = selection.mode === "model" ? (findOption(data, selection.model) ?? unlistedOption(selection.model)) : null;
	const efforts = option?.efforts ?? [];
	const effort = selection.mode === "model" && option ? shownEffort(selection, option) : undefined;

	const pickModel = (picked: ModelOption) => {
		const keep = selection.mode === "model" && selection.effort && picked.efforts.includes(selection.effort) ? selection.effort : undefined;
		setChoice({ mode: "model", model: picked.id, ...(keep ? { effort: keep } : {}) });
		// Modelo com esforço ajustável: a folha fica aberta para a linha "Esforço" (como o seletor do web).
		if (picked.efforts.length === 0) onClose();
	};
	const pickEffort = (next: ReasoningEffort | undefined) => {
		if (!option) return;
		// Salva já normalizado para o modelo ("Desligado" vira "Baixo" onde ele não desliga), como o web mostra e o servidor usa.
		const saved = effortForModel(next, option.id, option.info);
		setChoice({ mode: "model", model: option.id, ...(saved ? { effort: saved } : {}) });
		setPage("main");
	};

	const modelRows = (options: ModelOption[]) =>
		options.map((item, index) => <Row key={item.id} first={index === 0} title={item.name} hint={item.description} selected={selection.mode === "model" && selection.model === item.id} onPress={() => pickModel(item)} />);

	const others = data ? visibleOthers(data.others, showAllOthers) : { shown: [], hidden: 0 };

	if (page === "effort" && option) {
		return (
			<DraggableSheet
				visible={visible}
				onClose={onClose}
				onRequestClose={() => setPage("main")}
				header={
					<Pressable role="button" accessibilityLabel="Voltar" onPress={() => setPage("main")} className="min-h-11 flex-row items-center gap-2 self-start pr-4 active:opacity-70">
						<ChevronLeftIcon size={20} />
						<Text className="text-control font-semibold">Esforço</Text>
					</Pressable>
				}
			>
				<Card>
					{[undefined, ...efforts].map((level, index) => (
						<Row
							key={level ?? "default"}
							first={index === 0}
							title={effortLabel(level)}
							label={`${effortLabel(level)}${level === RECOMMENDED_EFFORT ? `, ${RECOMMENDED}` : ""}`}
							selected={effort === level}
							onPress={() => pickEffort(level)}
							trailing={level === RECOMMENDED_EFFORT ? <Badge variant="info">{RECOMMENDED}</Badge> : undefined}
						/>
					))}
				</Card>
				<Text variant="caption" className="px-1">
					Mais esforço responde melhor e gasta mais. Menos é mais rápido e barato.
				</Text>
			</DraggableSheet>
		);
	}

	return (
		<DraggableSheet visible={visible} onClose={onClose} header={<Text variant="heading">Selecionar modelo</Text>}>
			{catalog.status === "loading" && !data ? (
				<View className="flex-row items-center gap-3 rounded-card bg-muted px-5 py-5">
					<Spinner label="Carregando modelos" />
					<Text variant="muted">Carregando modelos…</Text>
				</View>
			) : null}
			{catalog.status === "error" ? (
				<View className="gap-3 rounded-card bg-muted px-5 py-4">
					<Text variant="muted">Não consegui carregar os modelos agora.</Text>
					<Button size="sm" variant="secondary" className="self-start" onPress={loadCatalog}>
						<Text>Tentar de novo</Text>
					</Button>
				</View>
			) : null}
			{notice ? (
				<Text variant="caption" role="status" className="px-1 text-body">
					{notice}
				</Text>
			) : null}
			{unknownBot ? (
				<Text variant="caption" role="status" className="px-1 text-body">
					Não consegui ler o modelo atual.
				</Text>
			) : null}
			{data && data.featured.length > 0 ? <Card>{modelRows(data.featured)}</Card> : null}
			{option && efforts.length > 0 && selection.mode === "model" ? (
				<Card>
					<Row
						first
						title="Esforço"
						label={`Esforço, ${effortLabel(effort)}${effort === RECOMMENDED_EFFORT ? `, ${RECOMMENDED}` : ""}`}
						onPress={() => setPage("effort")}
						trailing={
							<View className="flex-row items-center gap-2">
								<Text variant="muted" className="text-control">
									{effortLabel(effort)}
								</Text>
								{effort === RECOMMENDED_EFFORT ? <Badge variant="info">{RECOMMENDED}</Badge> : null}
								<ChevronRightIcon />
							</View>
						}
					/>
				</Card>
			) : null}
			{data && data.others.length > 0 ? (
				<Card>
					<Pressable role="button" accessibilityLabel="Outros modelos" accessibilityState={{ expanded: othersOpen }} onPress={() => setOthersOpen((open) => !open)} className="min-h-14 flex-row items-center gap-3 px-5 active:bg-foreground/10">
						<Text className="flex-1 text-control">Outros modelos</Text>
						<Text variant="caption">{data.others.length}</Text>
						{othersOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
					</Pressable>
					{othersOpen ? (
						<>
							<View className="h-px bg-border" />
							{modelRows(others.shown)}
							{others.hidden > 0 ? (
								<>
									<View className="h-px bg-border" />
									<Pressable role="button" accessibilityLabel={`Ver tudo (${data.others.length})`} onPress={() => setShowAllOthers(true)} className="min-h-14 flex-row items-center px-5 active:bg-foreground/10">
										<Text className="text-control">Ver tudo ({data.others.length})</Text>
									</Pressable>
								</>
							) : null}
						</>
					) : null}
				</Card>
			) : null}
			<Card>
				<Row first title="Automático" hint="O Atlas escolhe o modelo pela dificuldade do pedido." label="Automático. O Atlas escolhe o modelo pela dificuldade do pedido." selected={selection.mode === "auto"} onPress={() => (setChoice({ mode: "auto" }), onClose())} />
			</Card>
		</DraggableSheet>
	);
}
