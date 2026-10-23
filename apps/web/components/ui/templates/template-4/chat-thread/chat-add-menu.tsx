"use client";

import {
	ArrowLeftIcon,
	CameraIcon,
	CheckIcon,
	ChevronRightIcon,
	GitPullRequestIcon,
	ImageIcon,
	PaperclipIcon,
	PlusIcon,
	ShieldCheckIcon,
	SparklesIcon,
	XIcon,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEV_APPROVAL_MODES, DEV_APPROVAL_MODE_HELP, DEV_APPROVAL_MODE_LABEL, type DevApprovalMode } from "@workspace/shared";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@workspace/ui/components/sheet";
import { InputGroupButton } from "@workspace/ui/components/input-group";
import { cn } from "@workspace/ui/lib/utils";

import { ChatAddDropdown } from "./chat-add-dropdown";
import { listBuiltinSkills, listSkills } from "@/lib/atlas-api";

export type AddMenuSkill = { id: string; name: string; /** Nome em slug (o que `/skill` carrega). */ slug: string; description: string; factory: boolean };

type Step = "root" | "skills" | "permission";

const ROW_CLASS =
	"flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-[15px] outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 active:bg-muted";

/** Lista de skills do usuário e as de fábrica, carregadas ao abrir o passo "Skill". */
export function useAddMenuSkills(active: boolean): { skills: AddMenuSkill[]; loading: boolean } {
	const [skills, setSkills] = useState<AddMenuSkill[]>([]);
	const [loading, setLoading] = useState(false);
	const loaded = useRef(false);
	useEffect(() => {
		if (!active || loaded.current) return;
		loaded.current = true;
		setLoading(true);
		Promise.allSettled([listSkills(), listBuiltinSkills()])
			.then(([mine, factory]) => {
				const own = mine.status === "fulfilled" ? mine.value.filter((s) => s.enabled && s.status === "active").map((s) => ({ id: s.id, name: s.name, slug: s.name, description: s.description, factory: false })) : [];
				const builtin = factory.status === "fulfilled" ? factory.value.map((s) => ({ id: `builtin:${s.slug}`, name: s.name, slug: s.slug, description: s.description, factory: true })) : [];
				setSkills([...own, ...builtin]);
			})
			.finally(() => setLoading(false));
	}, [active]);
	return { skills, loading };
}

function Row({ icon: Icon, label, value, onClick, chevron = false, trailing, testId }: { icon?: LucideIcon; label: string; value?: string; onClick: () => void; chevron?: boolean; trailing?: ReactNode; testId?: string }) {
	return (
		<button className={ROW_CLASS} data-testid={testId} onClick={onClick} type="button">
			{Icon ? <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" /> : null}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{value ? <span className="max-w-[45%] truncate text-muted-foreground text-sm">{value}</span> : null}
			{trailing}
			{chevron ? <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
		</button>
	);
}

function Tile({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
	return (
		<button
			className="flex h-24 min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-muted/60 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 active:bg-muted"
			data-add-tile
			onClick={onClick}
			type="button"
		>
			<Icon aria-hidden className="size-6" />
			{label}
		</button>
	);
}

export type AddMenuPanelProps = {
	step: Step;
	onStep: (step: Step) => void;
	/** Fecha o menu (a ação já foi feita). */
	onClose: () => void;
	onPickPhotos: () => void;
	/** Qualquer arquivo (PDF, Word, planilha, texto, zip...). */
	onPickFile?: () => void;
	/** Só em telas touch: câmera do aparelho. */
	onTakePhoto?: () => void;
	showTestPr: boolean;
	onTestPr: () => void;
	onPickSkill: (skill: AddMenuSkill) => void;
	skills: AddMenuSkill[];
	skillsLoading: boolean;
	/** Presente só com as sessões de código ligadas. */
	permission?: { mode: DevApprovalMode; onChange: (mode: DevApprovalMode) => void };
	/** Mostra o X no cabeçalho (gaveta no celular). */
	showClose: boolean;
};

function Header({ title, onBack, onClose, showClose }: { title: string; onBack?: () => void; onClose: () => void; showClose: boolean }) {
	return (
		<div className="flex min-h-10 items-center gap-1 px-1 pb-1">
			{onBack ? (
				<button aria-label="Voltar" className="grid size-9 place-items-center rounded-full outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40" onClick={onBack} type="button">
					<ArrowLeftIcon className="size-5" />
				</button>
			) : null}
			<h2 className={cn("min-w-0 flex-1 truncate font-semibold text-base", onBack ? "" : "px-2")}>{title}</h2>
			{showClose ? (
				<button aria-label="Fechar" className="grid size-9 place-items-center rounded-full bg-muted/70 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40" onClick={onClose} type="button">
					<XIcon className="size-4" />
				</button>
			) : null}
		</div>
	);
}

/** Conteúdo do "+" do composer: o mesmo na gaveta (celular) e no popover (desktop). */
export function AddMenuPanel(props: AddMenuPanelProps) {
	const { step, onStep, onClose, showClose } = props;
	if (step === "skills") {
		const mine = props.skills.filter((s) => !s.factory);
		const factory = props.skills.filter((s) => s.factory);
		const group = (title: string, items: AddMenuSkill[]) =>
			items.length ? (
				<div className="flex flex-col" data-add-skill-group={title}>
					<p className="px-3 pt-2 pb-1 text-muted-foreground text-xs">{title}</p>
					{items.map((skill) => (
						<button className={cn(ROW_CLASS, "min-h-11")} key={skill.id} onClick={() => props.onPickSkill(skill)} title={skill.description} type="button">
							<SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate">{skill.name}</span>
						</button>
					))}
				</div>
			) : null;
		return (
			<div className="flex min-w-0 flex-col" data-add-step="skills">
				<Header onBack={() => onStep("root")} onClose={onClose} showClose={showClose} title="Skill" />
				<div className="max-h-[50dvh] overflow-y-auto">
					{props.skillsLoading ? <p className="px-3 py-4 text-muted-foreground text-sm">Carregando…</p> : null}
					{!props.skillsLoading && props.skills.length === 0 ? <p className="px-3 py-4 text-muted-foreground text-sm">Nenhuma skill disponível.</p> : null}
					{group("Minhas skills", mine)}
					{group("De fábrica", factory)}
				</div>
			</div>
		);
	}
	if (step === "permission" && props.permission) {
		const { mode, onChange } = props.permission;
		return (
			<div className="flex min-w-0 flex-col" data-add-step="permission">
				<Header onBack={() => onStep("root")} onClose={onClose} showClose={showClose} title="Permissão" />
				{DEV_APPROVAL_MODES.map((value) => (
					<button className={cn(ROW_CLASS, "items-start py-2.5")} key={value} onClick={() => onChange(value)} type="button">
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span>{value === "auto" ? `${DEV_APPROVAL_MODE_LABEL[value]} (recomendado)` : DEV_APPROVAL_MODE_LABEL[value]}</span>
							<span className="whitespace-normal text-muted-foreground text-xs leading-4">{DEV_APPROVAL_MODE_HELP[value]}</span>
						</span>
						{mode === value ? <CheckIcon aria-label="Selecionado" className="mt-0.5 size-5 shrink-0" /> : null}
					</button>
				))}
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-2" data-add-step="root">
			<Header onClose={onClose} showClose={showClose} title="Adicionar" />
			<div className="flex gap-2 px-1">
				{props.onTakePhoto ? <Tile icon={CameraIcon} label="Câmera" onClick={() => { props.onTakePhoto?.(); onClose(); }} /> : null}
				<Tile icon={ImageIcon} label="Fotos" onClick={() => { props.onPickPhotos(); onClose(); }} />
				{props.onPickFile ? <Tile icon={PaperclipIcon} label="Arquivo" onClick={() => { props.onPickFile?.(); onClose(); }} /> : null}
			</div>
			<div className="flex flex-col">
				{props.showTestPr ? <Row icon={GitPullRequestIcon} label="Testar uma PR" onClick={() => { props.onTestPr(); onClose(); }} testId="test-pr-item" /> : null}
				<Row chevron icon={SparklesIcon} label="Skill" onClick={() => onStep("skills")} />
				{props.permission ? <Row chevron icon={ShieldCheckIcon} label="Permissão" onClick={() => onStep("permission")} value={DEV_APPROVAL_MODE_LABEL[props.permission.mode]} /> : null}
			</div>
		</div>
	);
}

export type ChatAddMenuProps = Omit<AddMenuPanelProps, "step" | "onStep" | "onClose" | "showClose" | "skills" | "skillsLoading" | "onTakePhoto"> & {
	/** Câmera do aparelho (só no celular). */
	onTakePhoto: () => void;
	/** Teste/pré-visualização: abre já neste estado. */
	defaultOpen?: boolean;
	defaultStep?: Step;
};

/** Celular = gaveta com tiles; desktop = dropdown compacto. */
export function addMenuVariant(isMobile: boolean): "drawer" | "dropdown" {
	return isMobile ? "drawer" : "dropdown";
}

/** "+" do composer: gaveta no celular (alça, cabeçalho com X, passos com voltar) e popover no desktop com o mesmo conteúdo. */
export function ChatAddMenu({ defaultOpen = false, defaultStep = "root", onTakePhoto, ...rest }: ChatAddMenuProps) {
	const isMobile = useIsMobile();
	const [open, setOpen] = useState(defaultOpen);
	const [step, setStep] = useState<Step>(defaultStep);
	const { skills, loading } = useAddMenuSkills(open && step === "skills");
	const [drag, setDrag] = useState(0);
	const startY = useRef<number | null>(null);

	function changeOpen(next: boolean) {
		setOpen(next);
		if (!next) {
			setStep("root");
			setDrag(0);
		}
	}
	const panel = (
		<AddMenuPanel
			{...rest}
			onClose={() => changeOpen(false)}
			onStep={setStep}
			onTakePhoto={isMobile ? onTakePhoto : undefined}
			showClose={isMobile}
			skills={skills}
			skillsLoading={loading}
			step={step}
		/>
	);

	if (addMenuVariant(isMobile) === "drawer") {
		return (
			<>
				<InputGroupButton aria-label="Adicionar" onClick={() => changeOpen(true)} size="icon-sm" type="button" variant="secondary">
					<PlusIcon />
				</InputGroupButton>
				<Sheet onOpenChange={changeOpen} open={open}>
					<SheetContent
						className="rounded-t-3xl pb-[max(1.25rem,env(safe-area-inset-bottom))]"
						data-add-drawer
						showCloseButton={false}
						side="bottom"
						style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
					>
						<SheetTitle className="sr-only">Adicionar</SheetTitle>
						<div
							className="flex touch-none justify-center pt-2.5 pb-1"
							data-add-handle
							onPointerCancel={() => {
								startY.current = null;
								setDrag(0);
							}}
							onPointerDown={(event) => {
								startY.current = event.clientY;
								event.currentTarget.setPointerCapture(event.pointerId);
							}}
							onPointerMove={(event) => {
								if (startY.current !== null) setDrag(Math.max(0, event.clientY - startY.current));
							}}
							onPointerUp={() => {
								const far = drag > 90;
								startY.current = null;
								setDrag(0);
								if (far) changeOpen(false);
							}}
						>
							<span aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
						</div>
						<div className="px-3">{panel}</div>
					</SheetContent>
				</Sheet>
			</>
		);
	}
	return (
		<ChatAddDropdown
			onPickFile={rest.onPickFile}
			onPickPhotos={rest.onPickPhotos}
			onPickSkill={rest.onPickSkill}
			onTestPr={rest.onTestPr}
			permission={rest.permission}
			showTestPr={rest.showTestPr}
		/>
	);
}
