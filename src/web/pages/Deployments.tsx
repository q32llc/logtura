import {
  Alert,
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
import { IconCloudUpload, IconPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api";
import type { ApiConnection, ApiDeployment, ApiDeploymentStatus } from "../types";

const STATUS_COLOR: Record<ApiDeploymentStatus, string> = {
  pending: "yellow",
  running: "teal",
  crashed: "red",
  stopped: "gray",
  detached: "gray",
};

export function Deployments() {
  const [deployments, setDeployments] = useState<ApiDeployment[] | null>(null);
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listDeployments(), api.listConnections()])
      .then(([d, c]) => {
        setDeployments(d.deployments);
        setConnections(c.connections);
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load"),
      );
  }, []);

  const connectionsById = useMemo(() => {
    const map = new Map<string, ApiConnection>();
    for (const c of connections) map.set(c.id, c);
    return map;
  }, [connections]);

  return (
    <Container size="md">
      <Group justify="space-between" mb="lg">
        <Title order={1}>Deployments</Title>
        {connections.length > 0 && (
          <Button
            component={Link}
            to={`/app/connections/${connections[0]!.id}/deploy`}
            leftSection={<IconPlus size={16} />}
          >
            New deployment
          </Button>
        )}
      </Group>

      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}

      {deployments === null && (
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      )}

      {deployments && deployments.length === 0 && (
        <Card withBorder p="xl">
          <Stack align="center" gap="sm">
            <IconCloudUpload size={36} stroke={1.5} />
            <Text c="dimmed">No deployments yet.</Text>
            <Text size="sm" c="dimmed" maw={420} ta="center">
              A deployment is a named forwarder running on a target you
              choose (Fly, AWS, your own infra). Each one selects which
              sources to tail and which monitors apply.
            </Text>
            {connections.length > 0 ? (
              <Button
                component={Link}
                to={`/app/connections/${connections[0]!.id}/deploy`}
                mt="sm"
              >
                Create your first deployment
              </Button>
            ) : (
              <Button component={Link} to="/app/connections/new" mt="sm">
                Add a connection first
              </Button>
            )}
          </Stack>
        </Card>
      )}

      {deployments && deployments.length > 0 && (
        <Stack gap="sm">
          {deployments.map((d) => {
            const c = connectionsById.get(d.connectionId);
            return (
              <Card
                key={d.id}
                withBorder
                p="md"
                component={Link}
                to={`/app/deployments/${d.id}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <Group justify="space-between">
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text fw={600}>{d.displayName}</Text>
                      <Badge size="sm" variant="light">
                        {d.targetKind}
                      </Badge>
                      <Badge
                        size="sm"
                        variant="light"
                        color={STATUS_COLOR[d.status]}
                      >
                        {d.status}
                      </Badge>
                      {d.managed && (
                        <Badge size="sm" variant="default" color="teal">
                          managed
                        </Badge>
                      )}
                    </Group>
                    <Text size="sm" c="dimmed">
                      {c?.displayName ?? d.connectionId}
                      {d.sourceIds === null
                        ? " · all sources"
                        : ` · ${d.sourceIds.length} sources`}
                      {d.monitorIds === null
                        ? " · all monitors"
                        : ` · ${d.monitorIds.length} monitors`}
                    </Text>
                  </Stack>
                  <Button variant="subtle" size="sm">
                    View
                  </Button>
                </Group>
              </Card>
            );
          })}
        </Stack>
      )}
    </Container>
  );
}
