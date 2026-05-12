/**
 * Shared "Connect <Provider>" UX block. Originally lived inside
 * NewConnection.tsx; lifted here so the same control surface is
 * reused by the Reconnect modal (and any future place we ask the
 * user to authenticate against a provider).
 *
 * Renders one of:
 *   - external_token: a big "Connect <Provider>" button that opens
 *     the provider's prefilled token-creation page, then prompts
 *     the user to paste the resulting token into the form below.
 *   - oauth_redirect / cli_session: not implemented here (those
 *     surfaces have their own dedicated buttons in the destination
 *     and deploy-target flows).
 *
 * The host page handles the actual paste-field rendering through
 * `renderField` — this component only owns the "click to authorize"
 * affordance and the stepper that explains the flow's position.
 */
import { Anchor, Button, Group, Stack, Stepper, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { PasswordInput, TextInput } from "@mantine/core";
import type React from "react";
import type { ApiConnectFlow, ApiFormField } from "../types";

export interface ConnectSectionProps {
  providerName: string;
  flow: ApiConnectFlow;
  clicked: boolean;
  onConnect: () => void;
  showManual: boolean;
  toggleManual: () => void;
  /** Position in the (name → authorize → paste → verify) sequence
   *  the caller wants the stepper to highlight. Reconnect skips the
   *  name step, so it passes (1 + ...) to start at "authorize". */
  stepIndex: number;
  /** Whether to show the stepper at the top. Reconnect-style hosts
   *  with no name step disable it; NewConnection enables. */
  showStepper?: boolean;
  /** Connection display name from the host page. For oauth_redirect
   *  flows, this is sent to the start endpoint so the callback can
   *  create the connection with the user's chosen name. */
  displayName?: string;
}

export function ConnectSection({
  providerName,
  flow,
  clicked,
  onConnect,
  showManual,
  toggleManual,
  stepIndex,
  showStepper = true,
  displayName,
}: ConnectSectionProps) {
  if (flow.kind === "oauth_redirect") {
    const startHref = displayName
      ? `${flow.startPath}?display_name=${encodeURIComponent(displayName)}`
      : flow.startPath;
    const ready = !!displayName?.trim();
    return (
      <Stack gap="sm" mt="xs">
        <Text size="sm">{flow.buttonDescription}</Text>
        <Group gap="sm" align="center">
          <Button
            component="a"
            href={ready ? startHref : undefined}
            leftSection={<IconExternalLink size={16} />}
            disabled={!ready}
          >
            {flow.buttonLabel}
          </Button>
          {!ready && (
            <Text size="xs" c="dimmed">
              Pick a connection name first.
            </Text>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          You'll be redirected back here once authorization completes.
        </Text>
      </Stack>
    );
  }
  if (flow.kind !== "external_token") {
    // cli_session isn't wired here yet — the pages that use it own
    // their own buttons.
    return null;
  }
  return (
    <Stack gap="md" mt="xs">
      {showStepper && (
        <Stepper
          active={Math.min(stepIndex, 3)}
          size="sm"
          styles={{ separator: { marginInline: 8 } }}
        >
          <Stepper.Step label="Name" />
          <Stepper.Step label={`Authorize ${providerName}`} />
          <Stepper.Step label="Paste token" />
          <Stepper.Step label="Verify" />
        </Stepper>
      )}

      <Stack gap={4}>
        <Group gap="sm" align="center">
          <Button
            component="a"
            href={flow.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onConnect}
            leftSection={<IconExternalLink size={16} />}
            variant={clicked ? "default" : "filled"}
          >
            {clicked ? `Re-open ${providerName}` : flow.buttonLabel}
          </Button>
          {clicked && (
            <Text size="sm" c="dimmed">
              Paste the token below.
            </Text>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {flow.buttonDescription}
        </Text>
      </Stack>

      {flow.manualInstructions && (
        <Stack gap={4}>
          <Anchor
            component="button"
            type="button"
            size="xs"
            c="dimmed"
            onClick={toggleManual}
          >
            {showManual
              ? "Hide manual instructions"
              : "Or create the token manually"}
          </Anchor>
          {showManual && (
            <Text size="xs" c="dimmed">
              {flow.manualInstructions}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** Provider/destination form-field renderer. Shared with NewConnection
 *  and ReconnectModal so the paste-field UX is identical everywhere
 *  a user types credentials in. */
export function renderField(
  f: ApiFormField,
  values: Record<string, string>,
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>,
) {
  const props = {
    key: f.name,
    label: f.label,
    placeholder: f.placeholder,
    description: f.description,
    required: f.required,
    value: values[f.name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setValues((s) => ({ ...s, [f.name]: e.currentTarget.value })),
  };
  return f.type === "password" ? (
    <PasswordInput {...props} autoComplete="off" />
  ) : (
    <TextInput {...props} autoComplete="off" />
  );
}
