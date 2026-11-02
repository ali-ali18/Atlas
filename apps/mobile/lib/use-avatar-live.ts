// Liga o `createAvatarLive` (puro) ao relógio: recalcula quando a atividade muda e agenda o próximo instante em que o
// estado pode mudar só pelo tempo (fim da permanência, da comemoração, da cara de erro).
import * as React from "react";
import { createAvatarLive, type AvatarLiveInput, type AvatarLiveOutput } from "./avatar-live";

const IDLE: AvatarLiveOutput = { state: "idle", label: null, nextMs: null };

export function useAvatarLive(input: AvatarLiveInput): Pick<AvatarLiveOutput, "state" | "label"> {
	const live = React.useRef(createAvatarLive()).current;
	const [out, setOut] = React.useState<AvatarLiveOutput>(IDLE);
	const latest = React.useRef(input);
	latest.current = input;
	const key = `${JSON.stringify(input.activity)}|${input.running}|${input.paused}|${input.failures}|${input.finishes}`;

	React.useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = () => {
			const next = live.sync(latest.current, Date.now());
			setOut((previous) => (previous.state === next.state && previous.label === next.label ? previous : next));
			if (next.nextMs !== null) timer = setTimeout(run, next.nextMs + 20);
		};
		run();
		return () => clearTimeout(timer);
	}, [live, key]);

	return out;
}
