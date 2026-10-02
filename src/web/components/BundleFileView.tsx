import { Button, Code, CopyButton, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { ApiBundleFile } from "../types";

/** Downloads always contain original bytes, never a textual binary encoding. */
export function BundleFileView({file}: {file: ApiBundleFile}) {
  const binary = file.encoding === "base64";
  function download() {
    const bytes = binary
      ? Uint8Array.from(atob(file.content), char => char.charCodeAt(0))
      : new TextEncoder().encode(file.content);
    const url = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name.split("/").at(-1)!;
    link.click();
    URL.revokeObjectURL(url);
  }
  return <Stack gap="xs">
    <Group justify="space-between">
      <Code>{file.name}</Code>
      <Group gap="xs">
        <Button size="xs" variant="subtle" onClick={download}>Download</Button>
        {!binary && <CopyButton value={file.content}>{({copied, copy}) => <Button size="xs" variant="subtle" leftSection={copied ? <IconCheck size={14}/> : <IconCopy size={14}/>} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>}</CopyButton>}
      </Group>
    </Group>
    {file.mode !== undefined && <Text size="xs" c="dimmed">File mode: {file.mode.toString(8).padStart(3, "0")}</Text>}
    {binary ? <Text size="sm">Binary file. Download it and save it at the path shown above.</Text> : <ScrollArea.Autosize mah={500}>
      <pre style={{margin: 0, padding: "12px", border: "1px solid var(--mantine-color-default-border)", borderRadius: 6, fontSize: 13, lineHeight: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"}}><code>{file.content}</code></pre>
    </ScrollArea.Autosize>}
  </Stack>;
}
