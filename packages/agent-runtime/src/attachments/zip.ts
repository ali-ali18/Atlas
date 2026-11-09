// Leitor de zip movido para `@workspace/files/zip` (o adaptador de anexos do v4 precisa dele sem importar o agent-runtime).
export { ZIP_LIMITS, listZip, readZipEntry, safeEntryName, type ZipEntry, type ZipListing } from "@workspace/files/zip";
