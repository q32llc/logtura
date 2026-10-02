import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Modal,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBrandSlack,
  IconExternalLink,
  IconPlus,
  IconTrash,
  IconWebhook,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type {
  ApiDestination,
  ApiDestinationDriver,
  ApiFormField,
} from "../types";

const KIND_ICONS: Record<string, React.ReactNode> = {
  slack: <IconBrandSlack size={18} />,
  webhook: <IconWebhook size={18} />,
};

const NOTICE_MESSAGES: Record<string, string> = {
  slack_connected: "Slack workspace connected.",
};

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state: "Slack OAuth failed: bad state. Try connecting again.",
  slack_not_configured:
    "Slack OAuth isn't configured on this deployment. Use a webhook destination instead.",
  slack_exchange:
    "Slack rejected the OAuth exchange. Try again from scratch.",
};

export function Destinations() {
  const [params, setParams] = useSearchParams();
  const [destinations, setDestinations] = useState<ApiDestination[] | null>(
    null,
  );
  const [drivers, setDrivers] = useState<ApiDestinationDriver[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<ApiDestinationDriver | null>(null);

  const notice = params.get("notice");
  const errorParam = params.get("error");
  const noticeMessage = notice ? NOTICE_MESSAGES[notice] : null;
  const errorMessage = errorParam ? ERROR_MESSAGES[errorParam] : null;

  function dismissParams() {
    setParams({}, { replace: true });
  }

  async function refetch() {
    try {
      const r = await api.listDestinations();
      setDestinations(r.destinations);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refetch();
    api
      .destinationDrivers()
      .then((r) => setDrivers(r.drivers))
      .catch(() => {});
  }, []);

  async function destroy(id: string) {
    if (!confirm("Delete this destination? Sinks pointing at it will also be removed.")) return;
    try {
      await api.deleteDestination(id);
      notifications.show({ message: "Destination deleted", color: "teal" });
      refetch();
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
    }
  }

  return (
    <Container size="md">
      <Group justify="space-between" mb="lg">
        <Title order={1}>Destinations</Title>
      </Group>

      {noticeMessage && (
        <Alert color="teal" mb="md" withCloseButton onClose={dismissParams}>
          {noticeMessage}
        </Alert>
      )}
      {errorMessage && (
        <Alert color="red" mb="md" withCloseButton onClose={dismissParams}>
          {errorMessage}
        </Alert>
      )}
      {error && <Text c="red.4">{error}</Text>}

      <Card withBorder p="lg" mb="md">
        <Title order={3} size="h4" mb="sm">
          Add a destination
        </Title>
        <Text c="dimmed" size="sm" mb="md">
          Where do you want forwarded logs to land? Pick a destination type;
          monitors will route their matches here through sinks.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          {drivers.map((d) => (
            <Card
              key={d.id}
              component="button"
              type="button"
              aria-label={`Add ${d.displayName} destination`}
              withBorder
              p="md"
              style={{ cursor: "pointer", textAlign: "left" }}
              onClick={() => setAdding(d)}
            >
              <Group gap="sm" mb="xs">
                {KIND_ICONS[d.id] ?? null}
                <Text fw={600}>{d.displayName}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                {d.description}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </Card>

      {destinations === null && (
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      )}
      {destinations && destinations.length === 0 && (
        <Card withBorder p="lg">
          <Text c="dimmed" ta="center">
            No destinations yet. Pick one above.
          </Text>
        </Card>
      )}
      {destinations && destinations.length > 0 && (
        <Stack gap="sm">
          {destinations.map((d) => (
            <Card key={d.id} component="section" aria-label={`Destination ${d.displayName}`} withBorder p="md">
              <Group justify="space-between">
                <Group gap="sm">
                  {KIND_ICONS[d.kind] ?? null}
                  <Stack gap={2}>
                    <Group gap={6}>
                      <Text fw={600}>{d.displayName}</Text>
                      <Badge size="sm" variant="light">
                        {d.kind}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed">
                      Created {new Date(d.createdAt).toISOString().slice(0, 10)}
                    </Text>
                  </Stack>
                </Group>
                <Button
                  variant="subtle"
                  color="red"
                  size="sm"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => destroy(d.id)}
                >
                  Delete
                </Button>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <AddDestinationModal
        driver={adding}
        onClose={() => setAdding(null)}
        onCreated={() => {
          setAdding(null);
          refetch();
        }}
      />
    </Container>
  );
}

function AddDestinationModal({
  driver,
  onClose,
  onCreated,
}: {
  driver: ApiDestinationDriver | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset state when driver changes.
  useEffect(() => {
    setDisplayName("");
    setFieldValues({});
    setErr(null);
  }, [driver?.id]);

  const opened = driver !== null;
  const isOauth =
    driver?.connectFlow?.kind === "oauth_redirect";

  async function submit() {
    if (!driver) return;
    setSubmitting(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set("kind", driver.id);
      form.set("display_name", displayName);
      for (const f of driver.formFields) {
        form.set(f.name, fieldValues[f.name] ?? "");
      }
      await api.createDestination(form);
      notifications.show({ message: "Destination added", color: "teal" });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={driver ? `Add ${driver.displayName} destination` : ""}
      size="md"
    >
      {driver && (
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            {driver.description}
          </Text>

          {isOauth && driver.connectFlow?.kind === "oauth_redirect" ? (
            <Stack gap="sm">
              <Text size="sm">{driver.connectFlow.buttonDescription}</Text>
              <Button
                component="a"
                href={driver.connectFlow.startPath}
                leftSection={<IconExternalLink size={16} />}
              >
                {driver.connectFlow.buttonLabel}
              </Button>
              <Text size="xs" c="dimmed">
                You'll be redirected back to logtura when authorization
                completes.
              </Text>
            </Stack>
          ) : (
            <>
              <TextInput
                label="Display name"
                placeholder="My alerts channel"
                value={displayName}
                onChange={(e) => setDisplayName(e.currentTarget.value)}
                required
              />
              {driver.formFields.map((f) => (
                <DriverField
                  key={f.name}
                  field={f}
                  value={fieldValues[f.name] ?? ""}
                  onChange={(v) =>
                    setFieldValues((s) => ({ ...s, [f.name]: v }))
                  }
                />
              ))}
              {err && (
                <Alert color="red" variant="light">
                  {err}
                </Alert>
              )}
              <Group justify="flex-end">
                <Button variant="subtle" onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button onClick={submit} loading={submitting}>
                  Add destination
                </Button>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function DriverField({
  field,
  value,
  onChange,
}: {
  field: ApiFormField;
  value: string;
  onChange: (v: string) => void;
}) {
  const props = {
    label: field.label,
    placeholder: field.placeholder,
    description: field.description,
    required: field.required,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(e.currentTarget.value),
    autoComplete: "off" as const,
  };
  return field.type === "password" ? (
    <PasswordInput {...props} />
  ) : (
    <TextInput {...props} />
  );
}
