import {
  Button,
  Group,
  ScrollArea,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useState } from "react";

export interface SelectionItem {
  id: string;
  label: string;
  sublabel?: string;
}

/**
 * A two-mode picker: "all" toggle plus an optional customized list of
 * specific IDs. Used by the deploy wizard and the deployment configure
 * tab to choose source/monitor subsets.
 *
 * `all=true` means "wildcard" — the consumer should treat the list as
 * null / not-explicitly-restricted. The actual `picked` set is only
 * meaningful when `all=false`.
 */
export function SelectionEditor({
  label,
  hint,
  all,
  onAll,
  items,
  picked,
  toggle,
  empty,
  initiallyExpanded = false,
}: {
  label: string;
  hint: string;
  all: boolean;
  onAll: (on: boolean) => void;
  items: SelectionItem[];
  picked: Set<string>;
  toggle: (id: string, on: boolean) => void;
  empty?: React.ReactNode;
  initiallyExpanded?: boolean;
}) {
  const [showCustomize, setShowCustomize] = useState(initiallyExpanded);
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Stack gap={2}>
          <Text fw={600}>{label}</Text>
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        </Stack>
        {items.length > 0 && (
          <Group gap="xs">
            <Switch
              checked={all}
              onChange={(e) => onAll(e.currentTarget.checked)}
              label={all ? "All selected" : `${picked.size} of ${items.length}`}
              size="sm"
            />
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setShowCustomize((v) => !v)}
            >
              {showCustomize ? "Hide" : "Customize"}
            </Button>
          </Group>
        )}
      </Group>
      {items.length === 0 && empty}
      {showCustomize && items.length > 0 && (
        <ScrollArea h={220}>
          <Stack gap={4}>
            {items.map((it) => (
              <Group key={it.id} justify="space-between">
                <Stack gap={0}>
                  <Text size="sm">{it.label}</Text>
                  {it.sublabel && (
                    <Text size="xs" c="dimmed">
                      {it.sublabel}
                    </Text>
                  )}
                </Stack>
                <Switch
                  aria-label={it.label}
                  checked={all || picked.has(it.id)}
                  onChange={(e) => toggle(it.id, e.currentTarget.checked)}
                  size="sm"
                />
              </Group>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Stack>
  );
}
