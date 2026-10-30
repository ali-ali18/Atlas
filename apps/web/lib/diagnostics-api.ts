import type { DiagnosticsView } from "@workspace/shared"
import { getAtlasApiBaseUrl } from "@/lib/atlas-api"
import { activeT } from "@/lib/i18n/active";

/** `GET /v1/diagnostics` (só o dono). Ficou fora de `atlas-api.ts` para não misturar com o fluxo do chat. */
export async function getDiagnostics(signal?: AbortSignal): Promise<DiagnosticsView> {
  const response = await fetch(`${getAtlasApiBaseUrl()}/v1/diagnostics`, { credentials: "same-origin", signal })
  if (!response.ok) {
    throw new Error(response.status === 403 ? activeT("errors.diagnosticsOwnerOnly") : activeT("errors.loadDiagnostics"))
  }
  return (await response.json()) as DiagnosticsView
}
