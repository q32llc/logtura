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
  IconArrowRight,
  IconCheck,
  IconClock,
  IconCloudUpload,
  IconExternalLink,
  IconKey,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { ConnectSection, renderField } from "../components/ConnectSection";
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
  const [pickerOpen, setPickerOpen] = useState(false);
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
            {connection.provider === "supabase-edge-logs" && (
              <>
                {" "}
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  onClick={() => setPickerOpen((v) => !v)}
                >
                  {connection.externalAccountId
                    ? pickerOpen
                      ? "hide picker"
                      : "change project"
                    : "pick project"}
                </Anchor>
              </>
            )}
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

      {connection.provider === "supabase-edge-logs" &&
        (!connection.externalAccountId || pickerOpen) && (
          <SupabaseProjectPicker
            connectionId={connection.id}
            currentRef={connection.externalAccountId}
            onPicked={(updated) => {
              setConnection(updated);
              setPickerOpen(false);
              notifications.show({
                message: `Picked ${updated.externalAccountId}; discovering…`,
                color: "teal",
              });
              void refetch();
            }}
          />
        )}

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
              p="md"
              radius="sm"
              component={Link}
              to={`/app/deployments/${d.id}`}
              style={{
                textDecoration: "none",
                color: "inherit",
                transition: "border-color 120ms ease, box-shadow 120ms ease",
              }}
            >
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap="xs">
                      <Text fw={700} truncate>
                        {d.displayName}
                      </Text>
                      <Badge size="sm" variant="light">
                        {d.targetKind}
                      </Badge>
                      {d.managed && (
                        <Badge size="sm" variant="default" color="teal">
                          managed
                        </Badge>
                      )}
                      {d.bundleOutdated && (
                        <Badge size="sm" variant="light" color="yellow">
                          redeploy needed
                        </Badge>
                      )}
                    </Group>
                    <Group gap="xs">
                      <Badge
                        size="sm"
                        variant="filled"
                        color={deploymentStatusColor(d.status)}
                      >
                        {d.status}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {d.lastSeenAt
                          ? `last seen ${relativeTime(d.lastSeenAt)}`
                          : "no heartbeat yet"}
                      </Text>
                    </Group>
                  </Stack>
                  <IconArrowRight size={18} color="var(--mantine-color-dimmed)" />
                </Group>

                <Group gap="xs">
                  <Badge size="lg" variant="light" radius="sm">
                    {deploymentSourceLabel(d)}
                  </Badge>
                  <Badge size="lg" variant="light" radius="sm">
                    {d.monitorIds === null
                      ? "all monitors"
                      : `${d.monitorIds.length} monitor${d.monitorIds.length === 1 ? "" : "s"}`}
                  </Badge>
                  <Badge size="lg" variant="light" radius="sm">
                    metrics {d.metricsTarget ?? "off"}
                  </Badge>
                </Group>

                {d.metricsSnapshot ? (
                  <Group gap="lg">
                    <MetricStat
                      label="received"
                      value={d.metricsSnapshot.totals.received}
                    />
                    <MetricStat
                      label="sent"
                      value={d.metricsSnapshot.totals.sent}
                    />
                    <MetricStat
                      label="errors"
                      value={d.metricsSnapshot.totals.errors}
                    />
                    <MetricStat
                      label="discarded"
                      value={d.metricsSnapshot.totals.discarded}
                    />
                    <Text size="xs" c="dimmed">
                      updated {relativeTime(d.metricsSnapshot.updatedAt)}
                    </Text>
                  </Group>
                ) : (
                  <Text size="xs" c="dimmed">
                    Metrics will appear after this forwarder starts reporting.
                  </Text>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function MetricStat({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap={0}>
      <Text size="sm" fw={700}>
        {formatCompactNumber(value)}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

function deploymentSourceLabel(deployment: ApiDeployment): string {
  if (deployment.sourceIds === null) return "all sources";
  const count = deployment.sourceIds.length;
  return `${count} source${count === 1 ? "" : "s"}`;
}

function deploymentStatusColor(status: ApiDeployment["status"]): string {
  switch (status) {
    case "running":
      return "teal";
    case "crashed":
      return "red";
    case "stopped":
      return "gray";
    case "detached":
      return "yellow";
    case "pending":
    default:
      return "blue";
  }
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value < 1000 ? 0 : 1,
  }).format(value);
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

function SupabaseProjectPicker({
  connectionId,
  currentRef,
  onPicked,
}: {
  connectionId: string;
  currentRef: string | null;
  onPicked: (c: ApiConnection) => void;
}) {
  type Project = {
    ref: string;
    name: string;
    organizationId: string | null;
    functionCount: number | null;
  };
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSupabaseProjects(connectionId)
      .then((r) => setProjects(r.projects))
      .catch((e) =>
        setErr(e instanceof ApiError ? e.message : "Failed to list projects"),
      );
  }, [connectionId]);

  async function pick(ref: string) {
    setBusyRef(ref);
    setErr(null);
    try {
      const res = await api.pickSupabaseProject(connectionId, ref);
      onPicked(res.connection);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Pick failed");
    } finally {
      setBusyRef(null);
    }
  }

  return (
    <Card withBorder p="lg" mt="md">
      <Stack gap="sm">
        <Title order={3} size="h4">
          Pick a Supabase project
        </Title>
        <Text size="sm" c="dimmed">
          The connected Supabase account can see {projects?.length ?? "…"}{" "}
          project{projects?.length === 1 ? "" : "s"}. Pick the one whose edge
          functions you want logs from. You can change this later by
          reconnecting.
        </Text>
        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}
        {!projects && !err && <Loader size="sm" />}
        {projects && projects.length === 0 && (
          <Text size="sm" c="dimmed">
            No projects visible to this token.
          </Text>
        )}
        {projects && projects.length > 0 && (
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>Ref</Table.Th>
                <Table.Th>Edge functions</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {projects.map((p) => {
                const isCurrent = p.ref === currentRef;
                return (
                  <Table.Tr key={p.ref}>
                    <Table.Td>
                      {p.name}
                      {isCurrent && (
                        <Badge size="xs" color="teal" ml="xs">
                          current
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {p.ref}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {p.functionCount === null ? "?" : p.functionCount}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-sm"
                        variant={
                          isCurrent
                            ? "default"
                            : p.functionCount === 0
                              ? "default"
                              : "filled"
                        }
                        disabled={isCurrent}
                        loading={busyRef === p.ref}
                        onClick={() => pick(p.ref)}
                      >
                        {isCurrent ? "Selected" : "Pick"}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}

function RailwayEnvironmentPicker({
  connectionId,
  currentAccountId,
  onPicked,
}: {
  connectionId: string;
  currentAccountId: string | null;
  onPicked: (c: ApiConnection) => void;
}) {
  type Project = {
    id: string;
    name: string;
    environments: Array<{
      id: string;
      name: string;
      serviceCount: number | null;
    }>;
  };
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRailwayEnvironments(connectionId)
      .then((r) => setProjects(r.projects))
      .catch((e) =>
        setErr(e instanceof ApiError ? e.message : "Failed to list environments"),
      );
  }, [connectionId]);

  async function pick(projectId: string, environmentId: string) {
    const key = `${projectId}:${environmentId}`;
    setBusyKey(key);
    setErr(null);
    try {
      const res = await api.pickRailwayEnvironment(connectionId, {
        projectId,
        environmentId,
      });
      onPicked(res.connection);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Pick failed");
    } finally {
      setBusyKey(null);
    }
  }

  const visibleRows =
    projects?.flatMap((project) =>
      project.environments.map((environment) => ({
        project,
        environment,
        key: `${project.id}:${environment.id}`,
      })),
    ) ?? [];

  return (
    <Card withBorder p="lg" mt="md">
      <Stack gap="sm">
        <Title order={3} size="h4">
          Pick a Railway environment
        </Title>
        <Text size="sm" c="dimmed">
          The connected Railway account can see {projects?.length ?? "…"}{" "}
          project{projects?.length === 1 ? "" : "s"}. Pick the environment
          whose services you want logs from.
        </Text>
        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}
        {!projects && !err && <Loader size="sm" />}
        {projects && visibleRows.length === 0 && (
          <Text size="sm" c="dimmed">
            No environments visible to this token.
          </Text>
        )}
        {visibleRows.length > 0 && (
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>Environment</Table.Th>
                <Table.Th>Services</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visibleRows.map(({ project, environment, key }) => {
                const isCurrent = key === currentAccountId;
                return (
                  <Table.Tr key={key}>
                    <Table.Td>
                      <Text size="sm">{project.name}</Text>
                      <Text size="xs" ff="monospace" c="dimmed">
                        {project.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {environment.name}
                      {isCurrent && (
                        <Badge size="xs" color="teal" ml="xs">
                          current
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {environment.serviceCount === null
                        ? "?"
                        : environment.serviceCount}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-sm"
                        variant={isCurrent ? "default" : "filled"}
                        disabled={isCurrent}
                        loading={busyKey === key}
                        onClick={() => pick(project.id, environment.id)}
                      >
                        {isCurrent ? "Selected" : "Pick"}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
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
  const [connectClicked, setConnectClicked] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset state every time the modal reopens.
  useEffect(() => {
    if (open) {
      setValues({});
      setConnectClicked(false);
      setShowManual(false);
      setErr(null);
    }
  }, [open]);

  const formFields = provider?.formFields ?? [];
  const connectFlow = provider?.connectFlow ?? null;
  const oauthShortcut = provider?.oauthShortcut ?? null;

  // Match NewConnection's flow: until the user clicks "Connect
  // <Provider>", hide the paste-token field so the call-to-action
  // doesn't compete with the input. For providers without a connect
  // flow (none currently), show all fields immediately.
  const fieldsToShow = formFields.filter((f) => {
    if (!connectFlow) return true;
    if (
      connectFlow.kind === "external_token" &&
      f.name === connectFlow.pasteFieldName
    ) {
      return connectClicked;
    }
    return true;
  });

  // Stepper: 0 = authorize, 1 = paste, 2 = verify. Reconnect skips
  // the "name" step (the connection already exists).
  const stepIndex = !connectClicked
    ? 1
    : !values[connectFlow?.kind === "external_token" ? connectFlow.pasteFieldName : ""]
      ? 2
      : 3;

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
          Swap in a new token. The connection's id, deployments,
          monitors, and sinks all stay the same — this just updates
          the stored credentials and re-runs discovery. Useful after
          you rotate a token or add missing scopes.
        </Text>

        {oauthShortcut && (
          <Card withBorder p="md" radius="sm">
            <Stack gap="xs">
              <Text fw={600} size="sm">
                {oauthShortcut.buttonLabel}
              </Text>
              <Text size="xs" c="dimmed">
                {oauthShortcut.buttonDescription}
              </Text>
              <Group>
                <Button
                  component="a"
                  leftSection={<IconExternalLink size={16} />}
                  href={`${oauthShortcut.startPath}?reconnect_id=${connection.id}`}
                >
                  {oauthShortcut.buttonLabel}
                </Button>
              </Group>
            </Stack>
          </Card>
        )}

        {oauthShortcut && (
          <Divider
            label="Or paste a Personal Access Token"
            labelPosition="center"
          />
        )}

        {connectFlow && provider && (
          <ConnectSection
            providerName={provider.displayName}
            flow={connectFlow}
            clicked={connectClicked}
            onConnect={() => setConnectClicked(true)}
            showManual={showManual}
            toggleManual={() => setShowManual((v) => !v)}
            stepIndex={stepIndex}
            showStepper={false}
          />
        )}

        <form onSubmit={submit}>
          <Stack gap="md">
            {fieldsToShow.map((f) => renderField(f, values, setValues))}

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
                disabled={fieldsToShow.length === 0}
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
