import { cookies } from "next/headers";

import { Template4Client } from "./template-4-client";

const MIN_WIDTH = 260;
const MAX_WIDTH = 520;
const WIDTH_COOKIE = "template4_panel_width";

export async function Template4() {
	const store = await cookies();
	const raw = Number(store.get(WIDTH_COOKIE)?.value);
	const initialPanelWidth = Number.isFinite(raw)
		? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw))
		: undefined;

	return <Template4Client initialPanelWidth={initialPanelWidth} />;
}
