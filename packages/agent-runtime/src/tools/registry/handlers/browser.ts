import { navigateTimingTelemetry } from "../../../telemetry/step-telemetry.js";
import { captureModelScreenshot, parseScreenshotArgs, modelPointToScreen } from "../../screenshot-model.js";
import type { ToolContext, ToolResult } from "../types.js";
import { NATIVE_COMPUTER_TOOL_NAME, translateNativeComputerAction } from "../../computer-native.js";

import { checkLoginWall, executeComputerRefTool } from "../../computer-refs.js";
import { executeComputerReadTool } from "../../computer-read.js";
import { COMPUTER_TABS_TOOL_NAME, executeComputerTabsTool } from "../../computer-tabs.js";
import {
	formatBrowserText,
	formatScrollPosition,
	describeTypedText,
	formatReady,
	formatSettle,
	parseBrowserTextArgs,
} from "../../computer.js";
import { formatBrowserClick, formatBrowserType } from "../../computer-changes.js";

import type { ToolFamily } from "../registry.js";
import { executeTool } from "../execute.js";

async function handleScreenshot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const shot = await captureModelScreenshot(
		ctx.manager,
		await ctx.getSessionId(),
		parseScreenshotArgs(args),
	);
	return { summary: shot.summary, image: shot.dataUrl };
}

async function handleNavigate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const url = String(args.url ?? "").trim();
	if (!url) throw new Error("url vazia");
	const result = await ctx.manager.execNavigate(
		await ctx.getSessionId(),
		url,
	);
	return {
		summary: `Abriu ${result.url} (título: ${result.title})${result.ready === false ? formatReady(result) : formatSettle(result)}`,
		toolTelemetry: { nav: navigateTimingTelemetry(result) },
	};
}

async function handleClick(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const x = Number(args.x);
	const y = Number(args.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("coordenadas inválidas");
	}
	const sessionId = await ctx.getSessionId();
	// O modelo clica nas coordenadas da screenshot reduzida; volta à tela real.
	const target = modelPointToScreen(sessionId, x, y);
	const effect = await ctx.manager.execClick(sessionId, target.x, target.y);
	return {
		summary: `Clique em (${Math.round(x)}, ${Math.round(y)})${formatSettle(effect)}`,
	};
}

async function handleType(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const text = String(args.text ?? "");
	const effect = await ctx.manager.execType(await ctx.getSessionId(), text);
	return { summary: `Digitou ${describeTypedText(text)}${formatSettle(effect)}` };
}

async function handleKey(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const combo = String(args.combo ?? "").trim();
	if (!combo) throw new Error("combo vazio");
	const effect = await ctx.manager.execKey(await ctx.getSessionId(), combo);
	return { summary: `Pressionou ${combo}${formatSettle(effect)}` };
}

async function handleScroll(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const deltaX = Number(args.deltaX ?? 0);
	const deltaY = Number(args.deltaY ?? 0);
	const position = await ctx.manager.execScroll(
		await ctx.getSessionId(),
		deltaX,
		deltaY,
	);
	return {
		summary: `Rolou (dx=${deltaX}, dy=${deltaY})${formatScrollPosition(position)}`,
	};
}

async function handleBrowserClick(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const selector =
		typeof args.selector === "string" ? args.selector : undefined;
	const text = typeof args.text === "string" ? args.text : undefined;
	if (!selector && !text) throw new Error("informe selector ou text");
	const result = await ctx.manager.execBrowserClick(
		await ctx.getSessionId(),
		{ selector, text },
	);
	return {
		summary: formatBrowserClick(result),
	};
}

async function handleBrowserType(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const text = String(args.text ?? "");
	const selector =
		typeof args.selector === "string" ? args.selector : undefined;
	const submit = Boolean(args.submit);
	const effect = await ctx.manager.execBrowserType(await ctx.getSessionId(), {
		selector,
		text,
		submit,
	});
	return {
		summary: formatBrowserType({ selector, submit }, effect),
	};
}

async function handleBrowserText(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const page = parseBrowserTextArgs(args);
	const result = await ctx.manager.execBrowserText(
		await ctx.getSessionId(),
		page,
	);
	const login = checkLoginWall(
		{ runId: ctx.runId, loginAsked: ctx.loginAsked ?? new Set<string>() },
		{ url: result.url, title: result.title, text: result.text },
	);
	return {
		summary: `${formatBrowserText(result)}${login?.note ?? ""}`,
		loginEvent: login?.loginEvent,
	};
}

async function handleBrowserLinks(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const result = await ctx.manager.execBrowserLinks(
		await ctx.getSessionId(),
	);
	const lines = result.links
		.slice(0, 25)
		.map((link) => `- ${link.text} → ${link.href}`);
	return { summary: lines.join("\n") || "sem links" };
}

async function handleBrowserSnapshotGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeComputerRefTool(name, args, {
		manager: ctx.manager,
		getSessionId: ctx.getSessionId,
		runId: ctx.runId,
		loginAsked: ctx.loginAsked ?? new Set<string>(),
	});
}

async function handleComputerTabs(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeComputerTabsTool(args, { manager: ctx.manager, getSessionId: ctx.getSessionId });
}

async function handleBrowserReadGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeComputerReadTool(name, args, {
		manager: ctx.manager,
		getSessionId: ctx.getSessionId,
		runId: ctx.runId,
		loginAsked: ctx.loginAsked ?? new Set<string>(),
	});
}

async function handleNativeComputer(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// F12/C4: traduz a ação nativa para as tools de coordenada e roda em sequência.
	const steps = translateNativeComputerAction(args);
	const summaries: string[] = [];
	let last: ToolResult | undefined;
	for (const step of steps) {
		last = await executeTool(step.name, step.args, ctx);
		summaries.push(last.summary);
	}
	return { summary: summaries.join("\n"), image: last?.image };
}

/** Família `browser`. */
export const BROWSER_TOOLS: ToolFamily = {
	"screenshot": { group: "browser", handler: handleScreenshot },
	"navigate": { group: "browser", handler: handleNavigate },
	"click": { group: "browser", handler: handleClick },
	"type": { group: "browser", handler: handleType },
	"key": { group: "browser", handler: handleKey },
	"scroll": { group: "browser", handler: handleScroll },
	"browser_click": { group: "browser", handler: handleBrowserClick },
	"browser_type": { group: "browser", handler: handleBrowserType },
	"browser_text": { group: "browser", handler: handleBrowserText },
	"browser_links": { group: "browser", handler: handleBrowserLinks },
	"browser_snapshot": { group: "browser", handler: (args, ctx) => handleBrowserSnapshotGroup("browser_snapshot", args, ctx) },
	"browser_act": { group: "browser", handler: (args, ctx) => handleBrowserSnapshotGroup("browser_act", args, ctx) },
	"browser_wait": { group: "browser", handler: (args, ctx) => handleBrowserSnapshotGroup("browser_wait", args, ctx) },
	[COMPUTER_TABS_TOOL_NAME]: { group: "browser", handler: handleComputerTabs },
	"browser_read": { group: "browser", handler: (args, ctx) => handleBrowserReadGroup("browser_read", args, ctx) },
	"browser_find": { group: "browser", handler: (args, ctx) => handleBrowserReadGroup("browser_find", args, ctx) },
	[NATIVE_COMPUTER_TOOL_NAME]: { group: "browser", handler: handleNativeComputer },
};
