import { ProviderCallback } from "@/components/providers/provider-callback"
import { parseProviderCallbackParams } from "@/lib/provider-connect"

export const metadata = { title: "Conectar ChatGPT · Atlas" }

/** Retorno do login do ChatGPT (popup): só lê `provider`, `status` e um código de erro seguro. */
export default async function ProviderCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <ProviderCallback params={parseProviderCallbackParams(await searchParams)} />
}
