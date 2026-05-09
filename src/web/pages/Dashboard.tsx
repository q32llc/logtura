import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { ApiConnection } from "../types";

export function Dashboard() {
  const [connections, setConnections] = useState<ApiConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listConnections()
      .then((r) => setConnections(r.connections))
      .catch(() => setError("Failed to load connections"));
  }, []);

  return (
    <Container size="md">
      <Group justify="space-between" mb="lg">
        <Title order={1}>Connections</Title>
        <Button
          component={Link}
          to="/app/connections/new"
          leftSection={<IconPlus size={16} />}
        >
          Add connection
        </Button>
      </Group>

      {error && <Text c="red.4">{error}</Text>}

      {connections === null && !error && (
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      )}

      {connections && connections.length === 0 && (
        <Card withBorder p="xl">
          <Stack align="center" gap="sm">
            <Text c="dimmed">No connections yet.</Text>
            <Button component={Link} to="/app/connections/new">
              Add your first connection
            </Button>
          </Stack>
        </Card>
      )}

      {connections && connections.length > 0 && (
        <Stack gap="sm">
          {connections.map((c) => (
            <Card
              key={c.id}
              withBorder
              p="md"
              component={Link}
              to={`/app/connections/${c.id}`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <Group justify="space-between">
                <Stack gap={2}>
                  <Group gap="xs">
                    <Text fw={600}>{c.displayName}</Text>
                    <Badge size="sm" variant="light">
                      {c.provider}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {c.externalAccountId ?? "—"} ·{" "}
                    {c.lastDiscoveredAt
                      ? `last discovered ${formatRelative(c.lastDiscoveredAt)}`
                      : "not discovered yet"}
                  </Text>
                </Stack>
                <Button variant="subtle" size="sm">
                  Manage
                </Button>
              </Group>
            </Card>
          ))}
        </Stack>
      )}
    </Container>
  );
}

function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
