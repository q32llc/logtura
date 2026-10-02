import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BundleFileView } from "./BundleFileView";
import type { ApiBundleFile } from "../types";
function page(file: ApiBundleFile) {return render(<MantineProvider><BundleFileView file={file}/></MantineProvider>);}
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.onerror = reject; reader.readAsArrayBuffer(blob);});
}
it.each([
  {file: {name: "assets/custom/bytes.bin", content: "AP+ACg0=", encoding: "base64" as const, mode: 0o700}, bytes: new Uint8Array([0, 255, 128, 10, 13]), binary: true},
  {file: {name: "vector.yaml", content: "# café\nsources: {}\n"}, bytes: new TextEncoder().encode("# café\nsources: {}\n"), binary: false},
])("downloads original bytes for $file.name and retains the relative path", async ({file, bytes, binary}) => {
  let downloaded: Blob | undefined;
  Object.defineProperty(URL, "createObjectURL", {configurable: true, value: vi.fn((blob: Blob) => {downloaded = blob; return "blob:fixture";})});
  Object.defineProperty(URL, "revokeObjectURL", {configurable: true, value: vi.fn()});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) {expect(this.download).toBe(file.name.split("/").at(-1)); expect(this.href).toBe("blob:fixture");});
  page(file); expect(screen.getByText(file.name)).toBeTruthy();
  if(binary) {expect(screen.queryByRole("button", {name: "Copy"})).toBeNull(); expect(screen.getByText("File mode: 700")).toBeTruthy(); expect(document.body.textContent).not.toContain(file.content);}
  else {expect(screen.getByRole("button", {name: "Copy"})).toBeTruthy(); expect(screen.getByText("# café sources: {}", {exact: false})).toBeTruthy();}
  fireEvent.click(screen.getByRole("button", {name: "Download"}));
  expect(click).toHaveBeenCalledTimes(1); expect(Array.from(await blobBytes(downloaded!))).toEqual(Array.from(bytes)); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
});
it("copies existing text content and confirms the action", async () => {
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: vi.fn().mockResolvedValue(undefined)}});
  page({name: "Dockerfile", content: "FROM scratch"}); fireEvent.click(screen.getByRole("button", {name: "Copy"}));
  expect(await screen.findByRole("button", {name: "Copied"})).toBeTruthy(); expect(navigator.clipboard.writeText).toHaveBeenCalledWith("FROM scratch");
});
