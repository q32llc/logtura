import type { TarFile } from "@logtura/core";
import type { BundleFile } from "./types";
/** Explicit binary encoding keeps the existing text API backward compatible. */
export function serializeBundleFiles(files: TarFile[], languages: Record<string, string>): BundleFile[] {
  return files.map(file => {
    if (typeof file.content === "string") return {...file, content: file.content, language: languages[file.name]};
    let binary = "";
    for (const byte of file.content) binary += String.fromCharCode(byte);
    return {...file, content: btoa(binary), encoding: "base64"};
  });
}
