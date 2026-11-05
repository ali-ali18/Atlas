import type { HomeBot, SectionRef } from "@/lib/home-types";
import { useRouter } from "expo-router";
import * as React from "react";
import { KeyboardAvoidingView, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Fade } from "@/components/ui/fade";
import { HomeHeader } from "@/components/home/home-header";
import { PinnedGrid } from "@/components/home/pinned-grid";
import { SearchFooter } from "@/components/home/search-footer";
import { SectionBlock } from "@/components/home/section-block";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { HomeBotMenu } from "@/components/home/home-bot-menu";
import { HomeSectionMenu, commitSectionRename, type SectionMenuTarget } from "@/components/home/home-section-menu";
import { SectionRenameSheet } from "@/components/home/section-rename-sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { useHomeData } from "@/lib/home-data";
import { NO_SECTION_KEY } from "@/lib/home-list";
import { staleNotice } from "@/lib/home-copy";
import { buildHome, buildSearchIndex } from "@/lib/home-list";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const NO_BOTS: readonly HomeBot[] = [];
const NO_SECTIONS: readonly SectionRef[] = [];

/**
 * Home: fixados em grade, seções recolhíveis com as conversas, busca local no rodapé. Mesmo dado do web
 * (`GET /v1/bots` e `/v1/sections`), vindo do cache do aparelho e atualizado por cima (puxar para atualizar).
 */
export default function HomeScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const insets = useSafeAreaInsets();
	// Alturas medidas do cabeçalho e da busca: a lista passa por baixo deles e o conteúdo ganha esse espaço no início/fim.
	const [headerHeight, setHeaderHeight] = React.useState(0);
	const [footerHeight, setFooterHeight] = React.useState(0);
	const { name, email, image, apiFetch } = useAtlasSession();
	const { snapshot, refreshing, error, refresh, applySectionUpdate } = useHomeData();
	const [query, setQuery] = React.useState("");
	const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
	const [menuBot, setMenuBot] = React.useState<HomeBot | null>(null);
	const [menuSection, setMenuSection] = React.useState<SectionMenuTarget | null>(null);
	const [renamingSection, setRenamingSection] = React.useState<SectionMenuTarget | null>(null);
	// "agora" muda com cada atualização: a data da linha ("agora", "14:05") acompanha.
	// biome-ignore lint/correctness/useExhaustiveDependencies: snapshot renova o relógio de propósito
	const now = React.useMemo(() => new Date(), [snapshot]);

	const bots = snapshot?.bots ?? NO_BOTS;
	// O texto de busca de cada bot sai uma vez por retrato, não a cada tecla.
	const searchIndex = React.useMemo(() => buildSearchIndex(bots), [bots]);
	const layout = React.useMemo(() => buildHome(bots, snapshot?.sections ?? NO_SECTIONS, query, searchIndex), [bots, snapshot, query, searchIndex]);
	const searching = query.trim().length > 0;

	const open = React.useCallback(
		(bot: HomeBot) => {
			router.push(`/chat/${encodeURIComponent(bot.id)}` as never);
		},
		[router],
	);

	const hasContent = layout.pinned.length > 0 || layout.sections.some((section) => section.bots.length > 0);
	let body: React.ReactNode;
	if (!snapshot) {
		body = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{error === "network" ? "Sem conexão com o seu servidor." : "Não consegui carregar suas conversas."}
				</Text>
				<Button variant="secondary" onPress={() => void refresh()}>
					<Text>Tentar de novo</Text>
				</Button>
			</View>
		);
	} else if (searching && !hasContent) {
		body = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				Nada encontrado para “{query.trim()}”.
			</Text>
		);
	} else if (bots.length === 0) {
		body = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				Nenhum bot ainda.
			</Text>
		);
	} else {
		body = (
			<>
				{error ? <Text className="px-6 pt-2 text-caption text-muted-foreground">{staleNotice(error)}</Text> : null}
				<PinnedGrid pinned={layout.pinned} bots={bots} onOpen={open} onMenu={setMenuBot} />
				{layout.sections.map((section) => (
					<SectionBlock
						key={section.key}
						section={section}
						bots={bots}
						now={now}
						open={searching || !collapsed[section.key]}
						onToggle={() => setCollapsed((previous) => ({ ...previous, [section.key]: !previous[section.key] }))}
						onOpen={open}
						onMenu={setMenuBot}
						onSectionMenu={
							section.key === NO_SECTION_KEY
								? undefined
								: (target) => setMenuSection({ id: target.key, name: target.title })
						}
						showEmpty={!searching}
					/>
				))}
			</>
		);
	}

	return (
		<ScreenFrame edges={["bottom", "left", "right"]}>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<ScrollView
					className="flex-1"
					// A lista vai até o fundo e passa por trás da busca (ela flutua sobre as conversas, sem faixa opaca).
					style={{ marginBottom: -footerHeight }}
					contentContainerStyle={{ paddingTop: headerHeight, paddingBottom: footerHeight + 16 }}
					scrollIndicatorInsets={{ top: headerHeight, bottom: footerHeight }}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} progressViewOffset={headerHeight} tintColor={themeColor(scheme, "muted-foreground")} colors={[themeColor(scheme, "muted-foreground")]} />}
				>
					{body}
				</ScrollView>
				<Fade from="top" height={headerHeight + 16} className="absolute left-0 right-0 top-0" />
				<View className="absolute left-0 right-0 top-0 z-10" style={{ paddingTop: insets.top }} onLayout={(event) => setHeaderHeight(Math.round(event.nativeEvent.layout.height))}>
					<HomeHeader user={{ name, email, image }} onNew={() => router.push("/new-bot" as never)} />
				</View>
				<View className="z-10" onLayout={(event) => setFooterHeight(Math.round(event.nativeEvent.layout.height))}>
					<Fade from="bottom" height={footerHeight + 24} className="absolute bottom-0 left-0 right-0" />
					<SearchFooter query={query} onChange={setQuery} onGrid={() => router.push("/apps" as never)} />
				</View>
			</KeyboardAvoidingView>
			<HomeBotMenu bot={menuBot} onClose={() => setMenuBot(null)} />
			<HomeSectionMenu
				section={menuSection}
				onClose={() => setMenuSection(null)}
				onStartRename={setRenamingSection}
			/>
			<SectionRenameSheet
				section={renamingSection}
				onClose={() => setRenamingSection(null)}
				onSave={(name) => {
					const target = renamingSection;
					setRenamingSection(null);
					if (target) commitSectionRename(apiFetch, { applySectionUpdate, refresh }, target.id, target.name, name);
				}}
			/>
		</ScreenFrame>
	);
}
