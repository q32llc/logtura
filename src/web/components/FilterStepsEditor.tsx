import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { FilterStep } from "../types";

const STEP_KINDS: Array<FilterStep["kind"]> = [
  "errors",
  "match",
  "level",
  "dedup",
  "rollup",
  "rate_limit",
  "sample",
];

const KIND_LABEL: Record<FilterStep["kind"], string> = {
  errors: "Errors",
  match: "Match (regex)",
  level: "Level",
  dedup: "Dedup",
  rollup: "Rollup (summarize bursts)",
  rate_limit: "Rate-limit",
  sample: "Sample",
};

function defaultStep(kind: FilterStep["kind"]): FilterStep {
  switch (kind) {
    case "errors":
      return { kind };
    case "match":
      return { kind, pattern: "", mode: "exclude" };
    case "level":
      return { kind, level: "error", mode: "include" };
    case "dedup":
      return { kind, window_secs: 300, fields: ["message"] };
    case "rollup":
      return { kind, window_secs: 30, group_by: [], max_samples: 5 };
    case "rate_limit":
      return { kind, per_minute: 60 };
    case "sample":
      return { kind, rate: 0.1 };
  }
}

function chipLabel(step: FilterStep): string {
  switch (step.kind) {
    case "errors":
      return "errors";
    case "match":
      return `match: /${step.pattern.slice(0, 24)}/${step.mode === "exclude" ? " ✕" : ""}`;
    case "level":
      return `level ${step.mode === "exclude" ? "≠" : "="} ${step.level}`;
    case "dedup":
      return `dedup ${step.window_secs}s`;
    case "rollup":
      return `rollup ${step.window_secs}s`;
    case "rate_limit":
      return `≤${step.per_minute}/min`;
    case "sample":
      return `sample ${Math.round(step.rate * 100)}%`;
  }
}

export function FilterStepsEditor({
  steps,
  onChange,
  size = "sm",
  emptyHint = "No filters — pass everything through.",
}: {
  steps: FilterStep[];
  onChange: (next: FilterStep[]) => void;
  size?: "xs" | "sm";
  emptyHint?: string;
}) {
  const [editing, setEditing] = useState<{
    index: number;
    step: FilterStep;
    isNew: boolean;
  } | null>(null);

  function add(kind: FilterStep["kind"]) {
    setEditing({
      index: steps.length,
      step: defaultStep(kind),
      isNew: true,
    });
  }

  function commit(step: FilterStep, index: number, isNew: boolean) {
    const next = [...steps];
    if (isNew) next.push(step);
    else next[index] = step;
    onChange(next);
    setEditing(null);
  }

  function remove(idx: number) {
    onChange(steps.filter((_, i) => i !== idx));
  }

  return (
    <Stack gap={6}>
      {steps.length === 0 && (
        <Text size="xs" c="dimmed">
          {emptyHint}
        </Text>
      )}
      <Group gap={6} wrap="wrap">
        {steps.map((step, idx) => (
          <Badge
            key={idx}
            size={size === "xs" ? "sm" : "md"}
            variant="light"
            radius="sm"
            rightSection={
              <IconX
                size={10}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(idx);
                }}
              />
            }
            style={{ cursor: "pointer", textTransform: "none" }}
            onClick={() => setEditing({ index: idx, step, isNew: false })}
          >
            {chipLabel(step)}
          </Badge>
        ))}
        <Menu position="bottom-start" shadow="md">
          <Menu.Target>
            <Button
              size={size === "xs" ? "compact-xs" : "compact-sm"}
              variant="default"
              leftSection={<IconPlus size={10} />}
            >
              Add
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {STEP_KINDS.map((k) => (
              <Menu.Item key={k} onClick={() => add(k)}>
                {KIND_LABEL[k]}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>

      <StepEditModal
        editing={editing}
        onClose={() => setEditing(null)}
        onCommit={commit}
      />
    </Stack>
  );
}

function StepEditModal({
  editing,
  onClose,
  onCommit,
}: {
  editing: { index: number; step: FilterStep; isNew: boolean } | null;
  onClose: () => void;
  onCommit: (step: FilterStep, index: number, isNew: boolean) => void;
}) {
  const [draft, setDraft] = useState<FilterStep | null>(null);

  // Sync draft to incoming step when modal opens.
  if (editing && (!draft || draft.kind !== editing.step.kind)) {
    setDraft(editing.step);
  }
  if (!editing && draft) setDraft(null);

  const opened = editing !== null;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        editing
          ? `${editing.isNew ? "Add" : "Edit"} ${KIND_LABEL[editing.step.kind]}`
          : ""
      }
      size="sm"
    >
      {editing && draft && (
        <Stack gap="md">
          <StepFields step={draft} onChange={setDraft} />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                onCommit(draft, editing.index, editing.isNew)
              }
            >
              {editing.isNew ? "Add" : "Save"}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function StepFields({
  step,
  onChange,
}: {
  step: FilterStep;
  onChange: (next: FilterStep) => void;
}) {
  switch (step.kind) {
    case "errors":
      return (
        <Text size="sm" c="dimmed">
          Matches events where <code>.error == true</code> or{" "}
          <code>.level == "error"</code>. No config.
        </Text>
      );
    case "match":
      return (
        <Stack gap="sm">
          <TextInput
            label="Regex pattern"
            placeholder="timeout|connection refused"
            value={step.pattern}
            onChange={(e) =>
              onChange({ ...step, pattern: e.currentTarget.value })
            }
          />
          <Select
            label="Mode"
            data={[
              { value: "include", label: "Include matching events" },
              { value: "exclude", label: "Drop matching events" },
            ]}
            value={step.mode}
            onChange={(v) =>
              onChange({
                ...step,
                mode: (v ?? "exclude") as "include" | "exclude",
              })
            }
          />
          <TextInput
            label="Field (default: message)"
            placeholder="message"
            value={step.field ?? ""}
            onChange={(e) =>
              onChange({
                ...step,
                field: e.currentTarget.value || undefined,
              })
            }
          />
        </Stack>
      );
    case "level":
      return (
        <Stack gap="sm">
          <TextInput
            label="Level"
            value={step.level}
            onChange={(e) =>
              onChange({ ...step, level: e.currentTarget.value })
            }
          />
          <Select
            label="Mode"
            data={[
              { value: "include", label: "Include this level" },
              { value: "exclude", label: "Drop this level" },
            ]}
            value={step.mode ?? "include"}
            onChange={(v) =>
              onChange({
                ...step,
                mode: (v ?? "include") as "include" | "exclude",
              })
            }
          />
        </Stack>
      );
    case "dedup":
      return (
        <Stack gap="sm">
          <NumberInput
            label="Window (seconds)"
            value={step.window_secs}
            min={1}
            onChange={(v) =>
              onChange({
                ...step,
                window_secs: typeof v === "number" ? v : 300,
              })
            }
          />
          <TextInput
            label="Fields (comma-separated)"
            placeholder="message"
            value={(step.fields ?? ["message"]).join(", ")}
            onChange={(e) =>
              onChange({
                ...step,
                fields: e.currentTarget.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Stack>
      );
    case "rollup":
      return (
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Collapse bursts into one summary event per window. Same
            messages within a window dedupe; the summary carries a
            count and up to N unique sample lines. Keeps Slack /
            email destinations sane during error storms.
          </Text>
          <NumberInput
            label="Window (seconds)"
            value={step.window_secs}
            min={5}
            onChange={(v) =>
              onChange({
                ...step,
                window_secs: typeof v === "number" ? v : 30,
              })
            }
          />
          <TextInput
            label="Group by (comma-separated; empty = global)"
            placeholder="script, logtura_connection_id"
            value={(step.group_by ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                ...step,
                group_by: e.currentTarget.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <NumberInput
            label="Max samples in summary"
            value={step.max_samples ?? 5}
            min={1}
            max={50}
            onChange={(v) =>
              onChange({
                ...step,
                max_samples: typeof v === "number" ? v : 5,
              })
            }
          />
        </Stack>
      );
    case "rate_limit":
      return (
        <NumberInput
          label="Max events per minute"
          value={step.per_minute}
          min={1}
          onChange={(v) =>
            onChange({
              ...step,
              per_minute: typeof v === "number" ? v : 60,
            })
          }
        />
      );
    case "sample":
      return (
        <NumberInput
          label="Keep fraction (0–1)"
          value={step.rate}
          min={0.001}
          max={1}
          step={0.05}
          onChange={(v) =>
            onChange({ ...step, rate: typeof v === "number" ? v : 0.1 })
          }
        />
      );
  }
}
