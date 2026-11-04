import { navigateTimingTelemetry } from "../../../telemetry/step-telemetry.js";
import { captureModelScreenshot, parseScreenshotArgs, modelPointToScreen } from "../../screenshot-model.js";
import type { ToolContext, ToolResult } from "../types.js";
import { NATIVE_COMPUTER_TOOL_NAME, translateNativeComputerAction } from "../../computer-native.js";

import { checkLoginWall, executeComputerRefTool, readLoginFields } from "../../computer-refs.js";
import { executeComputerReadTool } from "../../computer-read.js";
import { COMPUTER_TABS_TOOL_NAME, executeComputerTabsTool } from "../../computer-tabs.js";
import { formatBrowserText, formatScrollPosition, describeTypedText, formatReady, formatSettle, parseBrowserTextArgs } from "../../computer.js";
import { formatBrowserClick, formatBrowserType } from "../../computer-changes.js";

import type { ToolFamily } from "../registry.js";
import { executeTool } from "../execute.js";
import { attachVisionFallback, clickVision } from "../../vision-fallback.js";
import { defineRawTool, definedFamily, type DefinedTool, toolNamed } from "../../define-tool.js";
import { COMPUTER_REF_TOOLS } from "../../computer-refs.js";
import { COMPUTER_TABS_TOOL } from "../../computer-tabs.js";
import { COMPUTER_READ_TOOLS } from "../../computer-read.js";
import { NATIVE_COMPUTER_TOOL } from "../../computer-native.js";

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
	return attachVisionFallback({ summary: formatBrowserClick(result), ...clickVision(result) }, ctx);
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
	const loginPage = { url: result.url, title: result.title, text: result.text };
	const fields = await readLoginFields(ctx.manager, await ctx.getSessionId(), loginPage);
	const login = checkLoginWall(
		{ runId: ctx.runId, loginAsked: ctx.loginAsked ?? new Set<string>() },
		{ ...loginPage, ...(fields ? { fields } : {}) },
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
	const outcome = await executeComputerRefTool(name, args, {
		manager: ctx.manager,
		getSessionId: ctx.getSessionId,
		runId: ctx.runId,
		loginAsked: ctx.loginAsked ?? new Set<string>(),
	});
	return attachVisionFallback(outcome, ctx);
}

async function handleComputerTabs(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeComputerTabsTool(args, { manager: ctx.manager, getSessionId: ctx.getSessionId });
}

async function handleBrowserReadGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const outcome = await executeComputerReadTool(name, args, {
		manager: ctx.manager,
		getSessionId: ctx.getSessionId,
		runId: ctx.runId,
		loginAsked: ctx.loginAsked ?? new Set<string>(),
		canSeeImages: ctx.canSeeImages,
	});
	return attachVisionFallback(outcome, ctx);
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
/** Família `browser`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const BROWSER_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "screenshot",
		definition: {
				type: "function",
				function: {
					name: "screenshot",
					description:
						"Capture the screen as an image. USE for visual checks (canvas, charts, layout, other apps) and for what a read missed (side panel, chat answer, overlay). Do NOT use it for ordinary page text (browser_read). `region` zooms into the last image; `marks` draws each element's ref number (12 = e12) to click by ref.",
					parameters: {
						type: "object",
						properties: {
							region: {
								type: "object",
								description: "Zoom: rectangle in the coordinates of the last screenshot",
								properties: {
									x: { type: "number" },
									y: { type: "number" },
									width: { type: "number" },
									height: { type: "number" },
								},
								required: ["x", "y", "width", "height"],
							},
							marks: { type: "boolean", description: "Draw the ref number over each visible interactive element" },
						},
					},
				},
			},
		effect: "read",
		group: "browser",
		run: handleScreenshot,
	}),
	defineRawTool({
		name: "navigate",
		definition: {
				type: "function",
				function: {
					name: "navigate",
					description:
						"Open a URL in the VM browser; returns the final URL and title. USE to load a page you know. Do NOT use it to read the page or follow its links (browser_read, browser_act).",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string", description: "Full URL (https://...)" },
						},
						required: ["url"],
					},
				},
			},
		effect: "read",
		group: "browser",
		run: handleNavigate,
	}),
	defineRawTool({
		name: "click",
		definition: {
				type: "function",
				function: {
					name: "click",
					description:
						"Mouse click at screen coordinates (those of the latest screenshot). Desktop fallback: USE only for apps outside the browser, canvas, drag targets, or when browser_act failed twice. Do NOT use it for page elements that have a ref or visible text (use browser_act).",
					parameters: {
						type: "object",
						properties: {
							x: { type: "number" },
							y: { type: "number" },
						},
						required: ["x", "y"],
					},
				},
			},
		effect: "write_internal",
		group: "browser",
		run: handleClick,
	}),
	defineRawTool({
		name: "type",
		definition: {
				type: "function",
				function: {
					name: "type",
					description: "Type text into the element that has keyboard focus (desktop input). USE after a coordinate click in an app outside the browser. Do NOT use it for page fields (use browser_act type).",
					parameters: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
			},
		effect: "write_internal",
		group: "browser",
		run: handleType,
	}),
	defineRawTool({
		name: "key",
		definition: {
				type: "function",
				function: {
					name: "key",
					description:
						"Press a key combo in xdotool format (e.g. 'ctrl+l', 'Return', 'ctrl+t'). Desktop fallback for shortcuts and apps outside the browser. In a page, use browser_act press with a ref.",
					parameters: {
						type: "object",
						properties: { combo: { type: "string" } },
						required: ["combo"],
					},
				},
			},
		effect: "write_internal",
		group: "browser",
		run: handleKey,
	}),
	defineRawTool({
		name: "scroll",
		definition: {
				type: "function",
				function: {
					name: "scroll",
					description: "Scroll the screen by pixels (positive = down/right). Desktop fallback. To scroll a web page use browser_act scroll.",
					parameters: {
						type: "object",
						properties: {
							deltaX: { type: "number" },
							deltaY: { type: "number" },
						},
					},
				},
			},
		effect: "write_internal",
		group: "browser",
		run: handleScroll,
	}),
	defineRawTool({
		name: "browser_click",
		effect: "write_internal",
		group: "browser",
		run: handleBrowserClick,
	}),
	defineRawTool({
		name: "browser_type",
		effect: "write_internal",
		group: "browser",
		run: handleBrowserType,
	}),
	defineRawTool({
		name: "browser_text",
		effect: "read",
		group: "browser",
		run: handleBrowserText,
	}),
	defineRawTool({
		name: "browser_links",
		effect: "read",
		group: "browser",
		run: handleBrowserLinks,
	}),
	defineRawTool({
		name: "browser_snapshot",
		definition: toolNamed(COMPUTER_REF_TOOLS, "browser_snapshot"),
		effect: "read",
		group: "browser",
		run: (args, ctx) => handleBrowserSnapshotGroup("browser_snapshot", args, ctx),
	}),
	defineRawTool({
		name: "browser_act",
		definition: toolNamed(COMPUTER_REF_TOOLS, "browser_act"),
		effect: "write_internal",
		group: "browser",
		run: (args, ctx) => handleBrowserSnapshotGroup("browser_act", args, ctx),
	}),
	defineRawTool({
		name: "browser_wait",
		definition: toolNamed(COMPUTER_REF_TOOLS, "browser_wait"),
		effect: "read",
		poll: true,
		group: "browser",
		run: (args, ctx) => handleBrowserSnapshotGroup("browser_wait", args, ctx),
	}),
	defineRawTool({
		name: "browser_tabs",
		definition: COMPUTER_TABS_TOOL,
		effect: "write_internal",
		group: "browser",
		run: handleComputerTabs,
	}),
	defineRawTool({
		name: "browser_read",
		definition: toolNamed(COMPUTER_READ_TOOLS, "browser_read"),
		effect: "read",
		group: "browser",
		run: (args, ctx) => handleBrowserReadGroup("browser_read", args, ctx),
	}),
	defineRawTool({
		name: "browser_find",
		definition: toolNamed(COMPUTER_READ_TOOLS, "browser_find"),
		effect: "read",
		group: "browser",
		run: (args, ctx) => handleBrowserReadGroup("browser_find", args, ctx),
	}),
	defineRawTool({
		name: "computer",
		definition: NATIVE_COMPUTER_TOOL,
		effect: "write_internal",
		group: "browser",
		run: handleNativeComputer,
	}),
];

export const BROWSER_TOOLS: ToolFamily = definedFamily(BROWSER_DEFINED);
