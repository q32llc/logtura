import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  PasswordInput,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconCloudUpload,
  IconKey,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type {
  ApiConnection,
  ApiDeployment,
  ApiDestination,
  ApiJob,
  ApiJobStatus,
  ApiProvider,
  ApiSource,
} from "../types";

const ACTIVE_STATUSES: ApiJobStatus[] = ["queued", "running"];

export function ConnectionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [provider, setProvider] = useState<ApiProvider | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [deployments, setDeployments] = useState<ApiDeployment[]>([]);
  const [destinations, setDestinations] = useState<ApiDestination[]>([]);
  const [latestJob, setLatestJob] = useState<ApiJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"discover" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    if (!id) return;
    try {
      const [conn, deps] = await Promise.all([
        api.getConnection(id),
        api.listDeploymentsForConnection(id),
      ]);
      setConnection(conn.connection);
      setSources(conn.sources);
      setLatestJob(conn.latestDiscoveryJob);
      setDeployments(deps.deployments);
      // Pull the provider's formFields + connectFlow on first load
      // so the Reconnect modal can render the right inputs without
      // re-fetching every time.
      if (!provider) {
        const p = await api.providers();
        const driver = p.providers.find((x) => x.id === conn.connection.provider);
        if (driver) setProvider(driver);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }, [id, provider]);

  useEffect(() => {
    setLoading(true);
    refetch().finally(() => setLoading(false));
    api
      .listDestinations()
      .then((r) => setDestinations(r.destinations))
      .catch(() => {});
  }, [refetch]);

  // Poll while discovery is active.
  useEffect(() => {
    if (!latestJob || !ACTIVE_STATUSES.includes(latestJob.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => refetch(), 2000) as unknown as number;
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [latestJob, refetch]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.sourceKindLabel.toLowerCase().includes(q),
    );
  }, [sources, search]);

  const breakdownByKind = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sources)
      map.set(s.sourceKindLabel, (map.get(s.sourceKindLabel) ?? 0) + 1);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sources]);

  async function rediscover() {
    if (!id) return;
    setBusy("discover");
    try {
      const res = await api.rediscover(id);
      setLatestJob(res.job);
      notifications.show({
        message: res.deduped
          ? "Discovery is already running"
          : "Discovery queued",
        color: "teal",
      });
    } catch (e) {
      notifications.show({
        message:
          e instanceof ApiError ? e.message : "Could not queue discovery",
        color: "red",
      });
    } finally {
      setBusy(null);
    }
  }

  async function destroy() {
    if (!id) return;
    if (!confirm("Delete this connection? Deployments using it will be removed too.")) return;
    setBusy("delete");
    try {
      await api.deleteConnection(id);
      navigate("/app");
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed to delete",
        color: "red",
      });
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Container size="md">
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      </Container>
    );
  }

  if (!connection) {
    return (
      <Container size="md">
        <Alert color="red">{error ?? "Connection not found."}</Alert>
      </Container>
    );
  }

  const jobActive =
    latestJob !== null && ACTIVE_STATUSES.includes(latestJob.status);
  const hasDeployments = deployments.length > 0;

  return (
    <Container size="md">
      <Group justify="space-between" align="flex-end" mb="lg">
        <Stack gap={2}>
          <Title order={1}>{connection.displayName}</Title>
          <Text size="sm" c="dimmed">
            <Badge size="sm" variant="light" mr="xs">
              {connection.provider}
            </Badge>
            account {connection.externalAccountId ?? "—"}
          </Text>
        </Stack>
        <Group>
          <Button
            variant="default"
            leftSection={<IconKey size={16} />}
            onClick={() => setReconnectOpen(true)}
          >
            Reconnect
          </Button>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={rediscover}
            loading={busy === "discover"}
            disabled={jobActive}
          >
            {jobActive ? "Discovering…" : "Re-discover"}
          </Button>
          <Button
            color="red"
            variant="subtle"
            leftSection={<IconTrash size={16} />}
            onClick={destroy}
            loading={busy === "delete"}
          >
            Delete
          </Button>
        </Group>

        <ReconnectModal
          open={reconnectOpen}
          onClose={() => setReconnectOpen(false)}
          connection={connection}
          provider={provider}
          onReconnected={(updated) => {
            setConnection(updated);
            setReconnectOpen(false);
            notifications.show({
              message: "Reconnected — re-discovering sources",
              color: "teal",
            });
            void refetch();
          }}
        />
      </Group>

      <DiscoveryJobBanner job={latestJob} />

      {sources.length > 0 && destinations.length === 0 && (
        <Alert
          icon={<IconRoute size={18} />}
          color="teal"
          variant="light"
          mt="md"
          title="Where should errors land?"
        >
          <Text size="sm" mb="xs">
            We found {sources.length} source
            {sources.length === 1 ? "" : "s"}. Set up a destination so a
            deployment has somewhere to ship logs.
          </Text>
          <Button component={Link} to="/app/destinations" size="xs" color="teal">
            Set up a destination
          </Button>
        </Alert>
      )}

      <SimpleGridDeploymentsCard
        connectionId={connection.id}
        deployments={deployments}
        sources={sources.length}
        sourcesReady={sources.length > 0 && !jobActive}
        hasDestinations={destinations.length > 0}
      />

      <Card withBorder p="lg" mt="md">
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h4">
            Discovered log sources
          </Title>
          {sources.length > 0 && (
            <TextInput
              placeholder="Filter…"
              leftSection={<IconSearch size={14} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={220}
              size="xs"
            />
          )}
        </Group>

        {sources.length === 0 ? (
          <Stack align="center" gap="sm" py="lg">
            <Text c="dimmed">
              {jobActive
                ? "Discovery in progress…"
                : "No sources discovered yet."}
            </Text>
            {!jobActive && (
              <Text size="sm" c="dimmed">
                Try Re-discover, and check the API token has the right read
                scopes.
              </Text>
            )}
          </Stack>
        ) : (
          <Stack gap="sm">
            <Group gap="xs">
              {breakdownByKind.map(([label, count]) => (
                <Badge key={label} size="lg" variant="light" radius="sm">
                  {count} {label}
                  {count === 1 ? "" : "s"}
                </Badge>
              ))}
            </Group>
            <Text size="xs" c="dimmed">
              Source selection happens per deployment, not on the connection.
            </Text>
            <Divider />
            <ScrollArea h={Math.min(420, sources.length * 38 + 60)} type="auto">
              <Table stickyHeader striped horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th style={{ width: 160 }}>Kind</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filtered.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={2}>
                        <Text c="dimmed" size="sm" ta="center" py="md">
                          No sources match this filter.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    filtered.map((s) => (
                      <Table.Tr key={s.id}>
                        <Table.Td>
                          <Text
                            size="sm"
                            style={{
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, monospace",
                            }}
                          >
                            {s.displayName}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {s.sourceKindLabel}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <Text size="xs" c="dimmed">
              Showing {filtered.length} of {sources.length}
            </Text>
          </Stack>
        )}
      </Card>
    </Container>
  );
}

function SimpleGridDeploymentsCard({
  connectionId,
  deployments,
  sources,
  sourcesReady,
  hasDestinations,
}: {
  connectionId: string;
  deployments: ApiDeployment[];
  sources: number;
  sourcesReady: boolean;
  hasDestinations: boolean;
}) {
  return (
    <Card withBorder p="lg" mt="md">
      <Group justify="space-between" mb="sm">
        <Title order={3} size="h4">
          Deployments
        </Title>
        <Button
          component={Link}
          to={`/app/connections/${connectionId}/deploy`}
          leftSection={<IconCloudUpload size={16} />}
          size="sm"
          disabled={!sourcesReady}
        >
          New deployment
        </Button>
      </Group>
      {deployments.length === 0 ? (
        <Stack gap="xs">
          <Text c="dimmed" size="sm">
            No deployments yet. Each deployment is one running forwarder
            with its own source + monitor selection.
          </Text>
          {sourcesReady && hasDestinations && (
            <Text size="sm">
              {sources} source{sources === 1 ? "" : "s"} ready to forward.
            </Text>
          )}
        </Stack>
      ) : (
        <Stack gap="xs">
          {deployments.map((d) => (
            <Card
              key={d.id}
              withBorder
              p="sm"
              component={Link}
              to={`/app/deployments/${d.id}`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <Group justify="space-between">
                <Group gap="xs">
                  <Text fw={600}>{d.displayName}</Text>
                  <Badge size="sm" variant="light">
                    {d.targetKind}
                  </Badge>
                  <Badge size="sm" variant="light">
                    {d.status}
                  </Badge>
                  {d.managed && (
                    <Badge size="sm" variant="default" color="teal">
                      managed
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {d.sourceIds === null ? "all sources" : `${d.sourceIds.length} sources`}
                </Text>
              </Group>
            </Card>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function DiscoveryJobBanner({ job }: { job: ApiJob | null }) {
  if (!job) return null;
  if (job.status === "queued") {
    return (
      <Alert icon={<IconClock size={16} />} color="blue" variant="light" title="Discovery queued">
        Waiting for a worker to pick up the job.
      </Alert>
    );
  }
  if (job.status === "running") {
    return (
      <Alert icon={<Loader size={14} />} color="blue" variant="light" title="Discovery running">
        Asking the provider for log sources. This page updates automatically.
      </Alert>
    );
  }
  if (job.status === "failed") {
    return (
      <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light" title="Last discovery failed">
        {job.error ?? "Unknown error."} Click Re-discover to try again.
      </Alert>
    );
  }
  if (job.completedAt) {
    const ago = relativeTime(job.completedAt);
    const count =
      typeof job.result?.sourceCount === "number"
        ? job.result.sourceCount
        : null;
    return (
      <Alert icon={<IconCheck size={16} />} color="teal" variant="light" title="Last discovery succeeded">
        {count !== null
          ? `Found ${count} source${count === 1 ? "" : "s"} ${ago}.`
          : `Completed ${ago}.`}
      </Alert>
    );
  }
  return null;
}

function relativeTime(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function ReconnectModal({
  open,
  onClose,
  connection,
  provider,
  onReconnected,
}: {
  open: boolean;
  onClose: () => void;
  connection: ApiConnection;
  provider: ApiProvider | null;
  onReconnected: (c: ApiConnection) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset form when modal reopens.
  useEffect(() => {
    if (open) {
      setValues({});
      setErr(null);
    }
  }, [open]);

  const formFields = provider?.formFields ?? [];
  const connectFlow = provider?.connectFlow ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const form = new FormData();
      for (const f of formFields) {
        form.set(f.name, values[f.name] ?? "");
      }
      const res = await api.reconnectConnection(connection.id, form);
      onReconnected(res.connection);
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : "Could not reconnect — check the new token's scopes",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      opened={open}
      onClose={onClose}
      title="Reconnect"
      size="md"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Swap in a new token or set of credentials. The connection's
          id, deployments, monitors, and sinks all stay the same —
          this just updates the stored credentials and re-runs
          discovery. Useful when the token was rotated or you added
          missing scopes.
        </Text>

        {connectFlow && (
          <Alert color="blue" variant="light">
            This provider has a structured connect flow (
            {connectFlow.kind === "oauth_redirect"
              ? "OAuth"
              : connectFlow.kind === "cli_session"
                ? "CLI session"
                : "token paste"}
            ).{" "}
            {connectFlow.kind === "external_token" ? (
              <>
                You can grab a fresh token from the provider's dashboard
                — there's a link on{" "}
                <Anchor component={Link} to="/app/connections/new">
                  the new-connection page
                </Anchor>{" "}
                if you don't have the URL handy.
              </>
            ) : (
              <>
                The full connect flow lives on the new-connection page.
                For now, paste the credential fields below if you have
                them, or re-run the flow at{" "}
                <Anchor component={Link} to="/app/connections/new">
                  /app/connections/new
                </Anchor>{" "}
                and delete the old connection after.
              </>
            )}
          </Alert>
        )}

        <form onSubmit={submit}>
          <Stack gap="md">
            {formFields.length === 0 && (
              <Alert color="yellow" variant="light">
                This provider doesn't expose form fields — re-run the
                connect flow at /app/connections/new instead.
              </Alert>
            )}
            {formFields.map((f) => {
              const Input = f.type === "password" ? PasswordInput : TextInput;
              return (
                <Input
                  key={f.name}
                  label={f.label}
                  placeholder={f.placeholder}
                  description={f.description}
                  required={f.required}
                  value={values[f.name] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({
                      ...v,
                      [f.name]: e.currentTarget.value,
                    }))
                  }
                  autoComplete="off"
                />
              );
            })}

            {err && (
              <Alert color="red" variant="light">
                {err}
              </Alert>
            )}

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={formFields.length === 0}
              >
                Reconnect
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Modal>
  );
}
