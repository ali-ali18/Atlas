import { parentPort } from "node:worker_threads";
import { extractAttachment, pdfPageCount } from "./extract-core.js";
import type { ExtractInput } from "./extract.js";

/**
 * Entrada da worker thread de extração (ver `extract-pool.ts`). É o único lugar que carrega
 * pdf.js / mammoth / exceljs. O pool mata a thread (terminate) se passar do tempo ou da memória.
 */
type Request =
	| ({ id: number; op: "extract"; timeoutMs: number } & ExtractInput)
	| { id: number; op: "pageCount"; bytes: Uint8Array }
	| { id: number; op: "preview"; fileId: string; filename: string; bytes: Uint8Array };

if (!parentPort) throw new Error("extract-thread precisa rodar em worker thread");
const port = parentPort;

port.on("message", (message: Request) => {
	void (async () => {
		try {
			if (message.op === "pageCount") {
				port.postMessage({ id: message.id, ok: true, pageCount: await pdfPageCount(message.bytes) });
				return;
			}
			if (message.op === "preview") {
				const { buildFilePreview } = await import("../files/preview.js");
				port.postMessage({ id: message.id, ok: true, preview: await buildFilePreview({ id: message.fileId, filename: message.filename, bytes: message.bytes }) });
				return;
			}
			const extracted = await extractAttachment({ filename: message.filename, kind: message.kind, bytes: message.bytes, timeoutMs: message.timeoutMs });
			port.postMessage({ id: message.id, ok: true, extracted });
		} catch (error) {
			port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : "failed" });
		}
	})();
});
