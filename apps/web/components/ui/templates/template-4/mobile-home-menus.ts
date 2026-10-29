import {
	ArrowDownIcon,
	ArrowUpIcon,
	EyeOffIcon,
	FolderInputIcon,
	GaugeIcon,
	KeyRoundIcon,
	LogOutIcon,
	MailIcon,
	MailOpenIcon,
	MessageCircleIcon,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	SettingsIcon,
	StarIcon,
	StoreIcon,
	Trash2Icon,
	CopyIcon,
	type LucideIcon,
} from "lucide-react";
import type { Section } from "@workspace/shared";
import { defaultTranslator } from "@/lib/i18n/translator";
import type { Agent } from "./data";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE = 10;

export type AccountMenuItemId =
	| "settings"
	| "marketplace"
	| "providers"
	| "autonomy"
	| "logout";

export type AccountMenuItem = {
	id: AccountMenuItemId;
	label: string;
	group: "main" | "session";
	icon: LucideIcon;
};

/** Itens do dropdown do avatar na home mobile (mesmas ações do rodapé desktop). */
export function accountMenuItems({ t } = defaultTranslator): AccountMenuItem[] {
	return [
		{ id: "settings", label: t("mobile.menu.settings"), group: "main", icon: SettingsIcon },
		{ id: "marketplace", label: t("sidebar.marketplace"), group: "main", icon: StoreIcon },
		{ id: "providers", label: t("mobile.menu.providers"), group: "main", icon: KeyRoundIcon },
		{ id: "autonomy", label: t("sidebar.autonomy"), group: "main", icon: GaugeIcon },
		{ id: "logout", label: t("sidebar.signOut"), group: "session", icon: LogOutIcon },
	];
}

export type BotActionId =
	| "open"
	| "edit"
	| "pin"
	| "unpin"
	| "mark-read"
	| "mark-unread"
	| "copy-id"
	| "move"
	| "hide"
	| "delete"
	| "set-primary"
	| "replace-primary";

export type BotActionItem = {
	id: BotActionId;
	label: string;
	icon: LucideIcon;
	destructive?: boolean;
};

/** Ações do menu de pressionar-e-segurar; espelha o menu de contexto do desktop. */
export function botActionItems(
	agent: Pick<Agent, "pinned" | "notifications" | "isPrimary" | "members">,
	options: { canPickPrimary?: boolean } = {},
	{ t } = defaultTranslator,
): BotActionItem[] {
	const isGroup = (agent.members?.length ?? 0) > 0;
	const primaryItems: BotActionItem[] = isGroup || !options.canPickPrimary
		? []
		: agent.isPrimary
			? [{ id: "replace-primary", label: t("sidebar.menu.changePrimary"), icon: StarIcon }]
			: [{ id: "set-primary", label: t("sidebar.menu.setPrimary"), icon: StarIcon }];
	return [
		{ id: "open", label: t("mobile.menu.open"), icon: MessageCircleIcon },
		{ id: "edit", label: isGroup ? t("sidebar.menu.groupInfo") : t("sidebar.menu.edit"), icon: PencilIcon },
		...primaryItems,
		agent.pinned
			? { id: "unpin", label: t("sidebar.menu.unpin"), icon: PinOffIcon }
			: { id: "pin", label: t("sidebar.menu.pin"), icon: PinIcon },
		agent.notifications
			? { id: "mark-read", label: t("sidebar.menu.markRead"), icon: MailOpenIcon }
			: { id: "mark-unread", label: t("sidebar.menu.markUnread"), icon: MailIcon },
		{ id: "copy-id", label: t("sidebar.menu.copyId"), icon: CopyIcon },
		{ id: "move", label: t("mobile.changeSection"), icon: FolderInputIcon },
		{ id: "hide", label: t("mobile.menu.hide"), icon: EyeOffIcon },
		{ id: "delete", label: isGroup ? t("sidebar.menu.deleteGroup") : t("sidebar.menu.delete"), icon: Trash2Icon, destructive: true },
	];
}

export type SectionActionId = "rename" | "move-up" | "move-down" | "delete";

export type SectionActionItem = {
	id: SectionActionId;
	label: string;
	icon: LucideIcon;
	destructive?: boolean;
	disabled?: boolean;
};

/** Ações do menu de uma sessão (espelha o menu de contexto do SectionBlock desktop). */
export function sectionActionItems(
	sectionId: string,
	sections: Pick<Section, "id" | "order">[],
	{ t } = defaultTranslator,
): SectionActionItem[] {
	const ordered = [...sections].sort((a, b) => a.order - b.order);
	const index = ordered.findIndex((section) => section.id === sectionId);
	return [
		{ id: "rename", label: t("sidebar.section.rename"), icon: PencilIcon },
		{ id: "move-up", label: t("sidebar.section.moveUp"), icon: ArrowUpIcon, disabled: index <= 0 },
		{
			id: "move-down",
			label: t("sidebar.section.moveDown"),
			icon: ArrowDownIcon,
			disabled: index < 0 || index >= ordered.length - 1,
		},
		{ id: "delete", label: t("sidebar.section.delete"), icon: Trash2Icon, destructive: true },
	];
}

export type SectionChoice = {
	id: string | null;
	label: string;
	current: boolean;
};

/** Opções do passo "Trocar de sessão". */
export function sectionChoices(
	agent: Pick<Agent, "sectionId">,
	sections: Section[],
	{ t } = defaultTranslator,
): SectionChoice[] {
	const ordered = [...sections].sort((a, b) => a.order - b.order);
	const choices: SectionChoice[] = ordered.map((section) => ({
		id: section.id,
		label: section.name,
		current: agent.sectionId === section.id,
	}));
	if (agent.sectionId) choices.push({ id: null, label: t("sidebar.menu.removeFromSection"), current: false });
	return choices;
}

type Timers = {
	set: (fn: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

export type LongPress = {
	start: (x: number, y: number) => void;
	move: (x: number, y: number) => void;
	cancel: () => void;
	/** true se o último toque virou long-press (para ignorar o click seguinte). */
	consumeFired: () => boolean;
};

/** Detector de long-press: dispara após `delay`, cancela se o dedo se mover além da tolerância. */
export function createLongPress(
	onLongPress: () => void,
	options: { delay?: number; tolerance?: number; timers?: Timers } = {},
): LongPress {
	const delay = options.delay ?? LONG_PRESS_MS;
	const tolerance = options.tolerance ?? LONG_PRESS_MOVE_TOLERANCE;
	const timers: Timers = options.timers ?? {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	let handle: unknown = null;
	let origin: { x: number; y: number } | null = null;
	let fired = false;

	function cancel() {
		if (handle !== null) timers.clear(handle);
		handle = null;
		origin = null;
	}

	return {
		start(x, y) {
			cancel();
			fired = false;
			origin = { x, y };
			handle = timers.set(() => {
				handle = null;
				origin = null;
				fired = true;
				onLongPress();
			}, delay);
		},
		move(x, y) {
			if (!origin) return;
			if (Math.hypot(x - origin.x, y - origin.y) > tolerance) cancel();
		},
		cancel,
		consumeFired() {
			const value = fired;
			fired = false;
			return value;
		},
	};
}
