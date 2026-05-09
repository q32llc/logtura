import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDownload,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type { ApiConnection, ApiSource } from "../types";

export function ConnectionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"discover" | "save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    api
      .getConnection(id)
      .then((r) => {
        setConnection(r.connection);
        setSources(r.sources);
        setSelection(
          new Set(r.sources.filter((s) => s.selected).map((s) => s.id)),
        );
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.sourceKindLabel.toLowerCase().includes(q),
    );
  }, [sources, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, ApiSource[]>();
    for (const s of filtered) {
      const group = map.get(s.sourceKindLabel) ?? [];
      group.push(s);
      map.set(s.sourceKindLabel, group);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  function toggleAll(group: ApiSource[], checked: boolean) {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const s of group) {
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
      notifications.show({
        message: "Selection saved",
        color: "teal",
      });
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
      setSources(res.sources);
      setSelection(
        new Set(res.sources.filter((s) => s.selected).map((s) => s.id)),
      );
      // Refresh connection (lastDiscoveredAt)
      const r = await api.getConnection(id);
      setConnection(r.connection);
      notifications.show({
        message: `Re-discovery complete (${res.sources.length} sources)`,
        color: "teal",
      });
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Re-discovery failed",
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
          >
            Re-discover
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

      <Card withBorder p="lg">
        <Group justify="space-between" mb="md">
          <Title order={3} size="h4">
            Discovered log sources ({sources.length})
          </Title>
          <TextInput
            placeholder="Filter…"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={220}
          />
        </Group>

        {sources.length === 0 ? (
          <Stack align="center" gap="sm" py="lg">
            <Text c="dimmed">No sources discovered yet.</Text>
            <Text size="sm" c="dimmed">
              Try Re-discover, and check the API token has the right read
              scopes.
            </Text>
          </Stack>
        ) : (
          <Stack gap="lg">
            {grouped.map(([label, group]) => {
              const allSelected = group.every((s) => selection.has(s.id));
              const someSelected = group.some((s) => selection.has(s.id));
              return (
                <Stack key={label} gap="xs">
                  <Group justify="space-between">
                    <Text fw={600} size="sm">
                      {label}
                      <Text component="span" c="dimmed" ml={6}>
                        ({group.length})
                      </Text>
                    </Text>
                    <Checkbox
                      label="Select all"
                      size="xs"
                      checked={allSelected}
                      indeterminate={!allSelected && someSelected}
                      onChange={(e) =>
                        toggleAll(group, e.currentTarget.checked)
                      }
                    />
                  </Group>
                  <Stack gap={6}>
                    {group.map((s) => (
                      <Checkbox
                        key={s.id}
                        label={s.displayName}
                        checked={selection.has(s.id)}
                        onChange={(e) =>
                          toggleOne(s.id, e.currentTarget.checked)
                        }
                      />
                    ))}
                  </Stack>
                </Stack>
              );
            })}
          </Stack>
        )}

        {sources.length > 0 && (
          <Group justify="space-between" mt="xl">
            <Text size="sm" c="dimmed">
              {selection.size} selected of {sources.length}
            </Text>
            <Group>
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
          </Group>
        )}
      </Card>
    </Container>
  );
}
