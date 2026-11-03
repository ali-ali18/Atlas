import type { HomeBot, SectionRef } from "@/lib/home-types";
import { useRouter } from "expo-router";
import * as React from "react";
import { KeyboardAvoidingView, RefreshControl, ScrollView, View } from "react-native";
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
	const { name, email, image, signOut, changeServer, apiFetch } = useAtlasSession();
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
				{error ? <Text className="px-5 pt-2 text-caption text-muted-foreground">{staleNotice(error)}</Text> : null}
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
		<ScreenFrame>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<HomeHeader user={{ name, email, image }} onNew={() => router.push("/new-bot" as never)} onSignOut={() => void signOut()} onChangeServer={() => void changeServer()} />
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ paddingBottom: 16 }}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={themeColor(scheme, "muted-foreground")} colors={[themeColor(scheme, "muted-foreground")]} />}
				>
					{body}
				</ScrollView>
				<SearchFooter query={query} onChange={setQuery} onGrid={() => router.push("/apps" as never)} />
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
