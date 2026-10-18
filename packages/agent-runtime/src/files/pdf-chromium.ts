import { chromium } from "playwright-core";
import { runSandboxOperation } from "@workspace/sandbox";
import type { PrintPdf } from "./pdf.js";

/** Flags exigidas em container (sem sandbox de usuário, /dev/shm pequeno, sem GPU). */
const CONTAINER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

/** Chromium offline: cancellation closes the browser, including a late launch. */
export const printPdfWithChromium: PrintPdf = (html, signal) =>
	runSandboxOperation({ signal }, 60_000, async (operationSignal) => {
		const executablePath =
			process.env.ATLAS_PDF_CHROME_PATH?.trim() || undefined;
		const launch = chromium.launch({
			...(executablePath ? { executablePath } : { channel: "chrome" }),
			args: CONTAINER_ARGS,
		});
		// The launch promise itself is not abortable in Playwright.
		void launch.then(
			(browser) => {
				if (operationSignal.aborted)
					void browser.close().catch(() => undefined);
			},
			() => undefined,
		);
		let browser;
		try {
			browser = await launch;
		} catch (error) {
			operationSignal.throwIfAborted();
			const reason = error instanceof Error ? error.message.split("\n")[0] : "";
			throw new Error(
				`PDF generation failed: the server could not start Chromium (set ATLAS_PDF_CHROME_PATH). This is a server problem, not the user's. Tell the user plainly that the PDF could not be generated right now and offer the same content as .docx or .md instead; do not claim a PDF was created. ${reason}`.trim(),
			);
		}
		const close = () => {
			void browser.close().catch(() => undefined);
		};
		operationSignal.addEventListener("abort", close, { once: true });
		try {
			operationSignal.throwIfAborted();
			const context = await browser.newContext({
				javaScriptEnabled: false,
				offline: true,
			});
			operationSignal.throwIfAborted();
			const page = await context.newPage();
			await page.setContent(html, { waitUntil: "load" });
			operationSignal.throwIfAborted();
			const pdf = await page.pdf({ format: "A4", printBackground: true });
			return new Uint8Array(pdf);
		} finally {
			operationSignal.removeEventListener("abort", close);
			await browser.close().catch(() => undefined);
		}
	});
