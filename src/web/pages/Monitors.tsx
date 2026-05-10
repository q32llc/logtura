import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBell,
  IconLink,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api";
import { FilterStepsEditor } from "../components/FilterStepsEditor";
import type {
  ApiConnection,
  ApiDestination,
  ApiMonitor,
  ApiSinkRecord,
  FilterStep,
} from "../types";

export function Monitors() {
  const [monitors, setMonitors] = useState<ApiMonitor[] | null>(null);
  const [sinks, setSinks] = useState<ApiSinkRecord[]>([]);
  const [destinations, setDestinations] = useState<ApiDestination[]>([]);
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingSinkFor, setAddingSinkFor] = useState<ApiMonitor | null>(null);

  async function refetch() {
    try {
      const [m, d, c] = await Promise.all([
        api.listMonitors(),
        api.listDestinations(),
        api.listConnections(),
      ]);
      setMonitors(m.monitors);
      setSinks(m.sinks);
      setDestinations(d.destinations);
      setConnections(c.connections);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  const sinksByMonitor = useMemo(() => {
    const map = new Map<string, ApiSinkRecord[]>();
    for (const s of sinks) {
      const arr = map.get(s.monitorId) ?? [];
      arr.push(s);
      map.set(s.monitorId, arr);
    }
    return map;
  }, [sinks]);

  const destById = useMemo(() => {
    const map = new Map<string, ApiDestination>();
    for (const d of destinations) map.set(d.id, d);
    return map;
  }, [destinations]);

  const connById = useMemo(() => {
    const map = new Map<string, ApiConnection>();
    for (const c of connections) map.set(c.id, c);
    return map;
  }, [connections]);

  async function deleteMonitor(id: string) {
    if (!confirm("Delete this monitor and its sinks?")) return;
    try {
      await api.deleteMonitor(id);
      notifications.show({ message: "Monitor deleted", color: "teal" });
      refetch();
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
    }
  }

  async function deleteSink(id: string) {
    try {
      await api.deleteSink(id);
      refetch();
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
    }
  }

  async function toggleEnabled(monitor: ApiMonitor) {
    try {
      await api.updateMonitor(monitor.id, { enabled: !monitor.enabled });
      refetch();
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
    }
  }

  async function setMonitorSteps(monitor: ApiMonitor, steps: FilterStep[]) {
    try {
      await api.updateMonitor(monitor.id, { filterSteps: steps });
      // Optimistically update local state.
      setMonitors((prev) =>
        prev
          ? prev.map((m) =>
              m.id === monitor.id ? { ...m, filterSteps: steps } : m,
            )
          : prev,
      );
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
    }
  }

  async function setSinkSteps(sink: ApiSinkRecord, steps: FilterStep[]) {
    try {
      await api.updateSinkSteps(sink.id, steps);
      setSinks((prev) =>
        prev.map((s) => (s.id === sink.id ? { ...s, filterSteps: steps } : s)),
      );
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
        <Title order={1}>Monitors</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setCreating(true)}
        >
          New monitor
        </Button>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      {monitors === null && (
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      )}

      {monitors && monitors.length === 0 && (
        <Card withBorder p="xl">
          <Stack align="center" gap="sm">
            <IconBell size={36} stroke={1.5} />
            <Text c="dimmed">No monitors yet.</Text>
            <Text size="sm" c="dimmed" maw={420} ta="center">
              A monitor watches your logs through a pipeline of filter
              steps and routes matches through sinks to destinations.
            </Text>
            <Button onClick={() => setCreating(true)} mt="sm">
              Create your first monitor
            </Button>
          </Stack>
        </Card>
      )}

      {monitors && monitors.length > 0 && (
        <Stack gap="md">
          {monitors.map((m) => {
            const monitorSinks = sinksByMonitor.get(m.id) ?? [];
            return (
              <Card key={m.id} withBorder p="md">
                <Group justify="space-between" mb="sm">
                  <Stack gap={2}>
                    <Group gap={6}>
                      <Text fw={600}>{m.displayName}</Text>
                      {m.connectionId ? (
                        <Badge size="sm" variant="default" leftSection={<IconLink size={10} />}>
                          {connById.get(m.connectionId)?.displayName ?? m.connectionId}
                        </Badge>
                      ) : (
                        <Badge size="sm" variant="default">
                          all connections
                        </Badge>
                      )}
                    </Group>
                  </Stack>
                  <Group gap="xs">
                    <Switch
                      size="sm"
                      checked={m.enabled}
                      onChange={() => toggleEnabled(m)}
                      label={m.enabled ? "Enabled" : "Disabled"}
                    />
                    <Button
                      variant="subtle"
                      color="red"
                      size="xs"
                      leftSection={<IconTrash size={12} />}
                      onClick={() => deleteMonitor(m.id)}
                    >
                      Delete
                    </Button>
                  </Group>
                </Group>

                <Stack gap={6} mt="xs">
                  <Text size="xs" c="dimmed" tt="uppercase" lts={1}>
                    Pipeline
                  </Text>
                  <FilterStepsEditor
                    steps={m.filterSteps}
                    onChange={(next) => setMonitorSteps(m, next)}
                    emptyHint="No filters — every event reaches the sinks below."
                  />
                </Stack>

                <Stack gap={6} mt="md">
                  <Text size="xs" c="dimmed" tt="uppercase" lts={1}>
                    Sinks
                  </Text>
                  {monitorSinks.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      No sinks. Add one to route matches to a destination.
                    </Text>
                  ) : (
                    <Stack gap="sm">
                      {monitorSinks.map((s) => {
                        const dest = destById.get(s.destinationId);
                        return (
                          <Card key={s.id} withBorder p="sm">
                            <Group justify="space-between" mb={6}>
                              <Group gap={6}>
                                <Text size="sm">
                                  → {dest?.displayName ?? s.destinationId}
                                </Text>
                                <Badge size="xs" variant="default">
                                  {dest?.kind ?? "?"}
                                </Badge>
                              </Group>
                              <Button
                                variant="subtle"
                                size="xs"
                                color="red"
                                onClick={() => deleteSink(s.id)}
                                leftSection={<IconX size={10} />}
                              >
                                Remove
                              </Button>
                            </Group>
                            <FilterStepsEditor
                              size="xs"
                              steps={s.filterSteps}
                              onChange={(next) => setSinkSteps(s, next)}
                              emptyHint="No per-sink refinement — uses the monitor's pipeline output as-is."
                            />
                          </Card>
                        );
                      })}
                    </Stack>
                  )}
                  <Button
                    variant="default"
                    size="xs"
                    mt="xs"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => setAddingSinkFor(m)}
                  >
                    Add sink
                  </Button>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}

      <CreateMonitorModal
        opened={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          refetch();
        }}
        connections={connections}
      />
      <AddSinkModal
        monitor={addingSinkFor}
        destinations={destinations}
        onClose={() => setAddingSinkFor(null)}
        onAdded={() => {
          setAddingSinkFor(null);
          refetch();
        }}
      />
    </Container>
  );
}

function CreateMonitorModal({
  opened,
  onClose,
  onCreated,
  connections,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
  connections: ApiConnection[];
}) {
  const [displayName, setDisplayName] = useState("");
  const [steps, setSteps] = useState<FilterStep[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setDisplayName("");
    setSteps([{ kind: "errors" }]);
    setConnectionId(null);
    setErr(null);
  }, [opened]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      await api.createMonitor({
        displayName: displayName.trim(),
        filterSteps: steps,
        connectionId,
      });
      notifications.show({ message: "Monitor created", color: "teal" });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New monitor" size="md">
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="Errors, 5xx-rate, …"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          required
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Filter pipeline
          </Text>
          <FilterStepsEditor
            steps={steps}
            onChange={setSteps}
            emptyHint="No filters — every event reaches the sinks. Add steps below."
          />
        </Stack>
        <Select
          label="Scope"
          description="Limit this monitor to one connection, or leave blank to apply to all."
          data={[
            { value: "", label: "All connections" },
            ...connections.map((c) => ({
              value: c.id,
              label: c.displayName,
            })),
          ]}
          value={connectionId ?? ""}
          onChange={(v) => setConnectionId(v ? v : null)}
        />
        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!displayName.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function AddSinkModal({
  monitor,
  destinations,
  onClose,
  onAdded,
}: {
  monitor: ApiMonitor | null;
  destinations: ApiDestination[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDestinationId(destinations[0]?.id ?? null);
    setErr(null);
  }, [monitor?.id, destinations]);

  async function submit() {
    if (!monitor || !destinationId) return;
    setSubmitting(true);
    setErr(null);
    try {
      await api.addSink(monitor.id, { destinationId });
      notifications.show({ message: "Sink added", color: "teal" });
      onAdded();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      opened={monitor !== null}
      onClose={onClose}
      title={monitor ? `Add sink to ${monitor.displayName}` : ""}
      size="sm"
    >
      <Stack gap="md">
        {destinations.length === 0 ? (
          <Alert color="yellow" variant="light">
            You don't have any destinations yet.{" "}
            <Link to="/app/destinations">Create one first.</Link>
          </Alert>
        ) : (
          <>
            <Select
              label="Destination"
              data={destinations.map((d) => ({
                value: d.id,
                label: `${d.displayName} (${d.kind})`,
              }))}
              value={destinationId}
              onChange={setDestinationId}
              required
            />
            <Text size="xs" c="dimmed">
              New sinks start with a default 5-minute dedup step. You can
              add more steps after creation.
            </Text>
            {err && <Alert color="red" variant="light">{err}</Alert>}
            <Group justify="flex-end">
              <Button variant="subtle" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} loading={submitting} disabled={!destinationId}>
                Add sink
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
