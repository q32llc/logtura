import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
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
  IconDownload,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type {
  ApiConnection,
  ApiJob,
  ApiJobStatus,
  ApiSource,
} from "../types";

const ACTIVE_STATUSES: ApiJobStatus[] = ["queued", "running"];

export function ConnectionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [latestJob, setLatestJob] = useState<ApiJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"discover" | "save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const pollRef = useRef<number | null>(null);
  // Track which source IDs we've seen across polls. When discovery is
  // streaming sources in, each refetch surfaces a few new rows; we want
  // any new server-selected source to go into the local selection so
  // "auto-select all" actually catches everything that lands, not just
  // the first batch. User edits to *existing* sources are preserved.
  const seenSourceIdsRef = useRef<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getConnection(id);
      setConnection(r.connection);
      setLatestJob(r.latestDiscoveryJob);

      const seen = seenSourceIdsRef.current;
      const newlySelectedIds: string[] = [];
      for (const s of r.sources) {
        if (!seen.has(s.id) && s.selected) newlySelectedIds.push(s.id);
      }
      seenSourceIdsRef.current = new Set(r.sources.map((s) => s.id));
      setSources(r.sources);
      if (newlySelectedIds.length > 0) {
        setSelection((prev) => {
          const next = new Set(prev);
          for (const sid of newlySelectedIds) next.add(sid);
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    refetch().finally(() => setLoading(false));
  }, [refetch]);

  // Poll while there's an active discovery job. Stops as soon as the
  // job lands in a terminal status (succeeded/failed).
  useEffect(() => {
    if (!latestJob || !ACTIVE_STATUSES.includes(latestJob.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      refetch();
    }, 2000) as unknown as number;
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

  // Counts per kind for the summary chips. Sorted by kind label.
  const breakdownByKind = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sources) {
      map.set(s.sourceKindLabel, (map.get(s.sourceKindLabel) ?? 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sources]);

  const selectedCount = useMemo(
    () => sources.reduce((n, s) => (selection.has(s.id) ? n + 1 : n), 0),
    [sources, selection],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selection.has(s.id));
  const someFilteredSelected =
    filtered.some((s) => selection.has(s.id)) && !allFilteredSelected;

  function toggleFiltered(checked: boolean) {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const s of filtered) {
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  }

  function toggleOne(id: string, checked: boolean) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    if (!id) return;
    setBusy("save");
    try {
      const res = await api.setSourceSelections(id, [...selection]);
      setSources(res.sources);
      notifications.show({ message: "Selection saved", color: "teal" });
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed to save",
        color: "red",
      });
    } finally {
      setBusy(null);
    }
  }

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
    if (!confirm("Delete this connection? Sources will be removed too.")) {
      return;
    }
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

  const dirty =
    sources.length > 0 &&
    sources.some((s) => s.selected !== selection.has(s.id));
  const jobActive =
    latestJob !== null && ACTIVE_STATUSES.includes(latestJob.status);

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
      </Group>

      <DiscoveryJobBanner job={latestJob} />

      <Card withBorder p="lg" mt="md">
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h4">
            Discovered log sources
          </Title>
          {sources.length > 0 && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced
                ? "Hide selection editor"
                : "Customize selection"}
            </Button>
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
          <Stack gap="md">
            <Group gap="xs">
              {breakdownByKind.map(([label, count]) => (
                <Badge key={label} size="lg" variant="light" radius="sm">
                  {count} {label}
                  {count === 1 ? "" : "s"}
                </Badge>
              ))}
            </Group>
            <Text size="sm" c="dimmed">
              {selectedCount === sources.length
                ? `Forwarding all ${sources.length}.`
                : selectedCount === 0
                  ? `None selected for forwarding.`
                  : `Forwarding ${selectedCount} of ${sources.length}.`}
            </Text>

            {showAdvanced && (
              <>
                <Divider />
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <TextInput
                    placeholder="Filter sources…"
                    leftSection={<IconSearch size={14} />}
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    flex={1}
                    miw={240}
                  />
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => toggleFiltered(true)}
                    >
                      Select all{search ? " filtered" : ""}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => toggleFiltered(false)}
                    >
                      Deselect all{search ? " filtered" : ""}
                    </Button>
                  </Group>
                </Group>

                <ScrollArea h={420} type="auto">
                  <Table
                    stickyHeader
                    striped
                    highlightOnHover
                    horizontalSpacing="md"
                  >
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th style={{ width: 40 }}>
                          <Checkbox
                            checked={allFilteredSelected}
                            indeterminate={someFilteredSelected}
                            onChange={(e) =>
                              toggleFiltered(e.currentTarget.checked)
                            }
                            aria-label="Select all"
                          />
                        </Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th style={{ width: 160 }}>Kind</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {filtered.length === 0 ? (
                        <Table.Tr>
                          <Table.Td colSpan={3}>
                            <Text c="dimmed" size="sm" ta="center" py="md">
                              No sources match this filter.
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ) : (
                        filtered.map((s) => (
                          <Table.Tr key={s.id}>
                            <Table.Td>
                              <Checkbox
                                checked={selection.has(s.id)}
                                onChange={(e) =>
                                  toggleOne(s.id, e.currentTarget.checked)
                                }
                                aria-label={`Toggle ${s.displayName}`}
                              />
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
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
              </>
            )}

            <Group justify="flex-end" mt="xs">
              <Button
                onClick={save}
                disabled={!dirty}
                loading={busy === "save"}
              >
                Save selection
              </Button>
              <Button
                component={Link}
                to={`/app/connections/${connection.id}/bundle`}
                leftSection={<IconDownload size={16} />}
                variant="default"
              >
                Generate Dockerfile
              </Button>
            </Group>
          </Stack>
        )}
      </Card>
    </Container>
  );
}

function DiscoveryJobBanner({ job }: { job: ApiJob | null }) {
  if (!job) return null;
  if (job.status === "queued") {
    return (
      <Alert
        icon={<IconClock size={16} />}
        color="blue"
        variant="light"
        title="Discovery queued"
      >
        Waiting for a worker to pick up the job.
      </Alert>
    );
  }
  if (job.status === "running") {
    return (
      <Alert
        icon={<Loader size={14} />}
        color="blue"
        variant="light"
        title="Discovery running"
      >
        Asking the provider for log sources. This page updates automatically.
      </Alert>
    );
  }
  if (job.status === "failed") {
    return (
      <Alert
        icon={<IconAlertTriangle size={16} />}
        color="red"
        variant="light"
        title="Last discovery failed"
      >
        {job.error ?? "Unknown error."} Click Re-discover to try again.
      </Alert>
    );
  }
  // succeeded
  if (job.completedAt) {
    const ago = relativeTime(job.completedAt);
    const count =
      typeof job.result?.sourceCount === "number"
        ? job.result.sourceCount
        : null;
    return (
      <Alert
        icon={<IconCheck size={16} />}
        color="teal"
        variant="light"
        title="Last discovery succeeded"
      >
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
