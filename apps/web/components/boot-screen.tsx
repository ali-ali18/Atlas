"use client"

import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

import { Avatar } from "@workspace/ui/components/avatar/avatar"

import {
	BOOT_FADE_MS,
	BOOT_MAX_MS,
	bootAction,
	bootPose,
	isAppReady,
	markAppReady,
	subscribeAppReady,
} from "@/lib/boot-screen"

const TICK_MS = 80
/** Caixa do avatar (em px, não vw): o mesmo tamanho no quadro parado (HTML do servidor) e no animado. */
const BOX = 166 // px: corpo visível de ~120px (o corpo ocupa ~72% da caixa), fixo, como no Grok

/**
 * Tela de abertura do app: só o avatar padrão sobre #09090b. O servidor já manda o quadro parado
 * (antes do JS); ao hidratar, se o app demorar, o mesmo avatar passa a dançar e mudar de expressão,
 * e some com um fade quando os dados iniciais chegam. Fica no layout raiz: só roda na abertura.
 */
export function BootScreen() {
	const pathname = usePathname()
	const [phase, setPhase] = useState<"still" | "dance" | "leaving" | "gone">("still")
	const [pose, setPose] = useState(() => bootPose(0))
	const [reduced, setReduced] = useState(false)
	const [danced, setDanced] = useState(false)

	// Fora da tela principal (login etc.) não há o que esperar.
	useEffect(() => {
		if (pathname !== "/") markAppReady()
	}, [pathname])

	useEffect(() => {
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
		setReduced(motion)
		const t0 = performance.now()
		let danceStart: number | null = null
		let leaving = false
		const step = () => {
			if (leaving) return
			const now = performance.now() - t0
			const action = bootAction(now, isAppReady(), danceStart)
			if (action === "hide") {
				leaving = true
				clearInterval(timer)
				setPhase("leaving")
				window.setTimeout(() => setPhase("gone"), BOOT_FADE_MS)
				return
			}
			if (action !== "dance") return
			if (danceStart === null) {
				danceStart = now
				if (!motion) {
					setPhase("dance") // movimento reduzido: fica no quadro parado
					setDanced(true)
				}
			}
			if (!motion) setPose(bootPose(now - danceStart))
		}
		const timer = window.setInterval(step, TICK_MS)
		const unsubscribe = subscribeAppReady(step)
		step()
		return () => {
			clearInterval(timer)
			unsubscribe()
		}
	}, [])

	if (phase === "gone") return null
	const animated = danced && !reduced

	return (
		<div
			aria-hidden="true"
			data-boot-screen=""
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 2147483000,
				display: "grid",
				placeItems: "center",
				background: "#09090b",
				opacity: phase === "leaving" ? 0 : 1,
				transition: `opacity ${BOOT_FADE_MS}ms ease-out`,
				pointerEvents: phase === "leaving" ? "none" : "auto",
				// Sem JS o quadro não pode ficar para sempre.
				animation: `boot-failsafe 0s linear ${BOOT_MAX_MS + 2000}ms forwards`,
			}}
		>
			<style>{"@keyframes boot-failsafe{to{opacity:0;visibility:hidden}}"}</style>
			<div style={{ width: BOX, height: BOX }}>
				<Avatar
					animated={animated}
					breathe={false}
					className="size-full!"
					color="#0086ff"
					expression={animated ? pose.expression : undefined}
					id="atlas-boot"
					shape="pebble"
					size={BOX}
					spinSignal={pose.spins}
					state={animated ? pose.state : "idle"}
				/>
			</div>
		</div>
	)
}
