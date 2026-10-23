import type { CodeRunInput, CodeRunResult, CodeRunnerOutputFile } from "@workspace/sandbox";

/**
 * Conferência visual do deck: converte o .pptx em PDF com o LibreOffice (headless) e rasteriza as primeiras
 * páginas em /work/preview, que o `run_code` devolve como imagens para o modelo. Script fixo, nosso.
 */
export const DECK_PREVIEW_PAGES = 12;

export const DECK_PREVIEW_SCRIPT = String.raw`
import glob, os, subprocess
src = sorted(glob.glob("in/*.pptx"))[0]
os.makedirs("/tmp/deck-pdf", exist_ok=True)
os.makedirs("/work/preview", exist_ok=True)
subprocess.run(["soffice", "--headless", "--norestore", "-env:UserInstallation=file:///tmp/lo-deck", "--convert-to", "pdf", "--outdir", "/tmp/deck-pdf", src], check=True, timeout=80, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pdf = sorted(glob.glob("/tmp/deck-pdf/*.pdf"))[0]
subprocess.run(["pdftoppm", "-r", "55", "-l", "12", "-png", pdf, "/work/preview/slide"], check=True, timeout=60)
print("PREVIEW pages=%d" % len(os.listdir("/work/preview")))
`;

export type PreviewOutcome = { ok: true; pages: CodeRunnerOutputFile[] } | { ok: false; reason: string };

/** Renderiza o deck já pronto. Nunca lança: a conferência é um extra, a falha vira um motivo honesto. */
export async function renderDeckPreview(bytes: Uint8Array, run: (input: CodeRunInput) => Promise<CodeRunResult>, signal?: AbortSignal): Promise<PreviewOutcome> {
	try {
		const result = await run({ code: DECK_PREVIEW_SCRIPT, files: [{ name: "deck.pptx", bytes }], timeoutSec: 100, ...(signal ? { signal } : {}) });
		const pages = [...(result.previews ?? [])].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
		if (result.exitCode === 0 && pages.length > 0) return { ok: true, pages };
		return { ok: false, reason: result.timedOut ? "the render timed out" : "LibreOffice could not render the file" };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		return { ok: false, reason: /não está (instalado|disponível)|not available|not installed/i.test(message) ? "the code runner is not available on this server" : "the render failed" };
	}
}
