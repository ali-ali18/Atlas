"use client";

// Avatar vivo: SVG chapado (corpo de cor sólida com os olhos RECORTADOS por
// uma <mask>) animado pelo motor puro em `lib/avatar`. O React renderiza o SVG
// UMA vez; a cada quadro o ticker compartilhado escreve só os atributos que
// mudaram, pelas refs. Não há estado do React por quadro nem transição CSS no
// SVG (ela brigaria com as escritas do rAF). Os ids da máscara vêm do
// `useId` (únicos por instância e iguais no servidor e na hidratação).
import {
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
	useState,
	useSyncExternalStore,
	type Ref,
} from "react";

import { createAvatarEngine } from "@workspace/ui/lib/avatar/engine";
import { resolveColor, resolveShape } from "@workspace/ui/lib/avatar/identity";
import type { Frame } from "@workspace/ui/lib/avatar/model/character";
import type { AvatarState } from "@workspace/ui/lib/avatar/model/behavior";
import {
	normalizeExpression,
	type Expression,
} from "@workspace/ui/lib/avatar/model/expressions";
import { stillFrame } from "@workspace/ui/lib/avatar/render/still";
import { HIDDEN_PART, PART_SLOTS, partAttrs } from "@workspace/ui/lib/avatar/render/parts";
import { createProjector, projectFrame } from "@workspace/ui/lib/avatar/render/project";
import {
	AVATAR_VIEWBOX,
	MASK_BOX,
	groupTransform,
	maskId,
	resolveEyes,
	safeColor,
} from "@workspace/ui/lib/avatar/render/svg";
import {
	getTicker,
	type AvatarHandle,
	type FollowMode,
} from "@workspace/ui/lib/avatar/runtime/ticker";
import { cn } from "@workspace/ui/lib/utils";

export type AvatarController = {
	blink(): void;
	look(dir: { x: number; y: number }): void;
	poke(x?: number, y?: number): void;
	setExpression(expression: Expression | string): void;
	restart(): void;
};

export type AvatarProps = {
	/** Rótulo acessível. Com `interactive`, vai no botão; sem, vira role="img". */
	ariaLabel?: string;
	className?: string;
	/** Cor do corpo; sem ela, o `id` sorteia uma da paleta. */
	color?: string;
	/** Cor do olho. Sem ela o olho é recortado (mostra o fundo atrás do avatar). */
	eyeColor?: string;
	/** Expressão fixa (os olhos); sem ela vale a do estado. */
	expression?: Expression | string;
	/** Desligado, desenha só o quadro de repouso (decorativo, sem loop). */
	animated?: boolean;
	/** Olhar: sempre (avatar grande), só no hover (barra lateral) ou nunca. */
	follow?: FollowMode;
	/** Identidade: define forma, cor e semente quando não informados. */
	id?: string;
	/** Vira um `<button>` que cutuca o avatar ao clicar. */
	interactive?: boolean;
	/** Mais vivo: olhos maiores e respiração maior. */
	isEmphasized?: boolean;
	onPoke?: () => void;
	/** Repouso vivo (clipes Idle com giro 3D). Desligue só em listas enormes. */
	breathe?: boolean;
	/** Cutuca ao clicar sem virar botão (quando o pai já é clicável). */
	pokeOnClick?: boolean;
	/** Força o modo reduzido (testes); por padrão segue o sistema. */
	reducedMotion?: boolean;
	ref?: Ref<AvatarController>;
	shape?: string;
	size?: number;
	/** Quando o número muda, o avatar dá um giro de 360°. */
	spinSignal?: number;
	state?: AvatarState;
};

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
	const media = window.matchMedia(REDUCED_QUERY);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion() {
	return useSyncExternalStore(
		subscribeReduced,
		() => window.matchMedia(REDUCED_QUERY).matches,
		() => false,
	);
}

type Markup = { transform: string; body: string; eyes: string };

function markupOf(frame: Frame): Markup {
	const { body, eyes } = projectFrame(frame);
	return { transform: groupTransform(frame), body, eyes };
}

export function Avatar({
	animated = true,
	ariaLabel,
	breathe = true, // era false: sem isso o idle nunca gira e o 3D não aparece
	className,
	color,
	expression,
	eyeColor,
	follow = "off",
	id = "atlas",
	interactive = false,
	isEmphasized = false,
	onPoke,
	pokeOnClick = false,
	reducedMotion,
	ref,
	shape,
	size = 56,
	spinSignal,
	state = "idle",
}: AvatarProps) {
	const systemReduced = usePrefersReducedMotion();
	const reduced = !animated || (reducedMotion ?? systemReduced);

	const resolvedShape = resolveShape(shape, id);
	const bodyColor = safeColor(resolveColor(color, id), "#777777");
	const eyes = resolveEyes(bodyColor, eyeColor);
	const uid = maskId(useId());
	const exprName = expression ? normalizeExpression(expression) : undefined;

	// Animado: o JSX nunca muda depois do primeiro render (quem escreve é o
	// ticker). Estático: acompanha as props.
	const [initial] = useState(() =>
		markupOf(stillFrame(resolvedShape, exprName ?? "neutral")),
	);
	const markup = reduced
		? markupOf(stillFrame(resolvedShape, exprName ?? "neutral"))
		: initial;

	const rootRef = useRef<HTMLElement | null>(null);
	const groupRef = useRef<SVGGElement | null>(null);
	const bodyRef = useRef<SVGPathElement | null>(null);
	const eyesRef = useRef<SVGPathElement | null>(null);
	// Partes do indicador (discos e anéis): círculos reservados, escondidos por padrão.
	const partRefs = useRef<(SVGCircleElement | null)[]>([]);
	const handleRef = useRef<AvatarHandle | null>(null);
	const written = useRef<Record<string, string>>({});
	const bodyColorRef = useRef(bodyColor);
	bodyColorRef.current = bodyColor;
	const projector = useRef<ReturnType<typeof createProjector> | null>(null);
	projector.current ??= createProjector();

	const apply = useCallback((frame: Frame) => {
		const cache = written.current;
		const put = (key: string, el: Element | null, name: string, value: string) => {
			if (!el || cache[key] === value) return;
			cache[key] = value;
			el.setAttribute(name, value);
		};
		// O projetor guarda o corpo: só reprojeta quando contorno/orientação mudam.
		const projected = (projector.current as ReturnType<typeof createProjector>)(frame);
		put("g", groupRef.current, "transform", groupTransform(frame));
		put("b", bodyRef.current, "d", projected.body);
		put("e", eyesRef.current, "d", projected.eyes);
		const parts = frame.indicator?.parts;
		if (parts || cache.parts) {
			cache.parts = parts ? "1" : "";
			for (let i = 0; i < PART_SLOTS; i++) {
				const attrs = partAttrs(parts?.[i], bodyColorRef.current);
				for (const [name, value] of Object.entries(attrs)) {
					put(`p${i}${name}`, partRefs.current[i] ?? null, name, value);
				}
			}
		}
	}, []);

	// Valores mais recentes, lidos pelo efeito de montagem sem virarem dependência.
	const latest = useRef({ shape: resolvedShape, exprName, state, isEmphasized, size });
	latest.current = { shape: resolvedShape, exprName, state, isEmphasized, size };

	useEffect(() => {
		if (reduced) return;
		const cur = latest.current;
		const engine = createAvatarEngine({
			shape: cur.shape,
			seed: id,
			breathe,
			size: cur.size,
		});
		engine.setExpression(cur.exprName ?? null);
		engine.setState(cur.state);
		engine.setEmphasis(cur.isEmphasized);
		written.current = {};
		projector.current = createProjector();
		const handle = getTicker().register({
			engine,
			apply,
			follow,
			element: rootRef.current,
			getCenter: () => {
				const rect = rootRef.current?.getBoundingClientRect();
				return rect
					? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
					: null;
			},
		});
		handleRef.current = handle;
		return () => {
			handle.unregister();
			handleRef.current = null;
		};
	}, [reduced, id, breathe, follow, apply]);

	// Trocar recorte ↔ pintura remonta os elementos: o cache de escritas vale
	// para os antigos, então zera e pede um quadro para repintar os novos.
	const firstMode = useRef(eyes.mode);
	useEffect(() => {
		if (firstMode.current === eyes.mode) return;
		firstMode.current = eyes.mode;
		written.current = {};
		projector.current = createProjector();
		handleRef.current?.interact((engine) => apply(engine.snapshot()));
	}, [eyes.mode, apply]);

	useEffect(() => {
		handleRef.current?.interact((engine) => engine.setExpression(exprName ?? null));
	}, [exprName]);

	useEffect(() => {
		handleRef.current?.interact((engine) => engine.setState(state));
	}, [state]);

	useEffect(() => {
		handleRef.current?.interact((engine) => engine.setEmphasis(isEmphasized));
	}, [isEmphasized]);

	useEffect(() => {
		handleRef.current?.interact((engine) => engine.setSize(size));
	}, [size]);

	const firstShape = useRef(resolvedShape);
	useEffect(() => {
		if (firstShape.current === resolvedShape) return;
		firstShape.current = resolvedShape;
		handleRef.current?.interact((engine) => engine.setBody(resolvedShape));
	}, [resolvedShape]);

	const firstSpin = useRef(spinSignal);
	useEffect(() => {
		if (firstSpin.current === spinSignal) return;
		firstSpin.current = spinSignal;
		handleRef.current?.interact((engine) => engine.spin());
	}, [spinSignal]);

	function pokeAt(x = 0, y = 0) {
		handleRef.current?.interact((engine) => engine.poke(x, y));
	}

	useImperativeHandle(
		ref,
		() => ({
			blink: () => handleRef.current?.interact((engine) => engine.blink()),
			look: (dir) => handleRef.current?.interact((engine) => engine.look(dir)),
			poke: pokeAt,
			setExpression: (next) =>
				handleRef.current?.interact((engine) => engine.setExpression(next)),
			restart: () =>
				handleRef.current?.interact((engine) => {
					engine.setBody(latest.current.shape, { instant: true });
					engine.setExpression(latest.current.exprName ?? null);
				}),
		}),
		// biome-ignore lint/correctness/useExhaustiveDependencies: o handle vive em ref
		[],
	);

	function onClick(event: React.MouseEvent) {
		const rect = rootRef.current?.getBoundingClientRect();
		// Teclado (Enter/Espaço) vem com detail 0 e sem posição: cutuca o centro.
		if (rect && event.detail > 0) {
			pokeAt(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				((event.clientY - rect.top) / rect.height) * 2 - 1,
			);
		} else {
			pokeAt();
		}
		onPoke?.();
	}

	const { min: maskMin, size: maskSize } = MASK_BOX;
	const maskAttrs = {
		height: maskSize,
		maskUnits: "userSpaceOnUse" as const,
		width: maskSize,
		x: maskMin,
		y: maskMin,
	};

	const partCircles = reduced ? null : Array.from({ length: PART_SLOTS }, (_, i) => (
		<circle
			cx={HIDDEN_PART.cx}
			cy={HIDDEN_PART.cy}
			fill={HIDDEN_PART.fill}
			// biome-ignore lint/suspicious/noArrayIndexKey: slots fixos do indicador
			key={i}
			opacity={HIDDEN_PART.opacity}
			r={HIDDEN_PART.r}
			ref={(node) => {
				partRefs.current[i] = node;
			}}
		/>
	));

	const svg =
		eyes.mode === "cutout" ? (
			<svg
				aria-hidden="true"
				className="size-full"
				focusable="false"
				viewBox={AVATAR_VIEWBOX}
			>
				<defs>
					<mask id={`${uid}-holes`} {...maskAttrs}>
						<rect
							fill="#fff"
							height={maskSize}
							width={maskSize}
							x={maskMin}
							y={maskMin}
						/>
						<path d={markup.eyes} fill="#000" ref={eyesRef} />
					</mask>
				</defs>
				<g ref={groupRef} transform={markup.transform}>
					<g mask={`url(#${uid}-holes)`}>
						<path d={markup.body} fill={bodyColor} ref={bodyRef} />
					</g>
					{partCircles}
				</g>
			</svg>
		) : (
			<svg
				aria-hidden="true"
				className="size-full"
				focusable="false"
				viewBox={AVATAR_VIEWBOX}
			>
				<defs>
					<path d={markup.body} id={`${uid}-body`} ref={bodyRef} />
					<mask id={`${uid}-inside`} {...maskAttrs}>
						<use fill="#fff" href={`#${uid}-body`} />
					</mask>
				</defs>
				<g ref={groupRef} transform={markup.transform}>
					<use fill={bodyColor} href={`#${uid}-body`} />
					<g mask={`url(#${uid}-inside)`}>
						<path d={markup.eyes} fill={eyes.color} ref={eyesRef} />
					</g>
					{partCircles}
				</g>
			</svg>
		);

	const common = {
		className: cn(
			"relative inline-block shrink-0 [&_svg]:size-full! group-data-[collapsible=icon]:size-12!",
			className,
		),
		onPointerEnter: () => handleRef.current?.setHovered(true),
		onPointerLeave: () => handleRef.current?.setHovered(false),
		style: { height: size, width: size },
	};

	if (interactive) {
		return (
			<button
				{...common}
				aria-label={ariaLabel}
				className={cn(common.className, "cursor-pointer rounded-full outline-offset-2")}
				onClick={onClick}
				ref={(node) => {
					rootRef.current = node;
				}}
				type="button"
			>
				{svg}
			</button>
		);
	}

	return (
		<span
			{...common}
			aria-hidden={ariaLabel ? undefined : true}
			aria-label={ariaLabel || undefined}
			onClick={pokeOnClick ? onClick : undefined}
			ref={(node) => {
				rootRef.current = node;
			}}
			role={ariaLabel ? "img" : undefined}
		>
			{svg}
		</span>
	);
}
