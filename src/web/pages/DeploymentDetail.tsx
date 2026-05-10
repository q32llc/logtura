import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Container,
  CopyButton,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type { ApiDeployment, ApiTargetBundle } from "../types";

export function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<ApiDeployment | null>(null);
  const [bundle, setBundle] = useState<ApiTargetBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"delete" | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getDeployment(id)
      .then((r) => setDeployment(r.deployment))
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load"),
      );
    api
      .getDeploymentBundle(id)
      .then(setBundle)
      .catch(() => {});
  }, [id]);

  async function destroy() {
    if (!id) return;
    if (!confirm("Delete this deployment? The container won't be stopped automatically.")) return;
    setBusy("delete");
    try {
      await api.deleteDeployment(id);
      notifications.show({ message: "Deployment deleted", color: "teal" });
      navigate("/app/deployments");
    } catch (e) {
      notifications.show({
        message: e instanceof ApiError ? e.message : "Failed",
        color: "red",
      });
      setBusy(null);
    }
  }

  if (error) {
    return (
      <Container size="md">
        <Alert color="red">{error}</Alert>
      </Container>
    );
  }

  if (!deployment) {
    return (
      <Container size="md">
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      </Container>
    );
  }

  return (
    <Container size="md">
      <Group justify="space-between" mb="md">
        <Stack gap={2}>
          <Title order={1}>{deployment.displayName}</Title>
          <Group gap={6}>
            <Badge variant="light">{deployment.targetKind}</Badge>
            <Badge variant="light">{deployment.status}</Badge>
            {deployment.managed && (
              <Badge variant="default" color="teal">
                managed
              </Badge>
            )}
          </Group>
        </Stack>
        <Group>
          <Button
            component={Link}
            to="/app/deployments"
            variant="subtle"
            leftSection={<IconArrowLeft size={16} />}
          >
            Back
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

      <Card withBorder p="lg" mb="md">
        <Stack gap={6}>
          <Text fw={600}>Selection</Text>
          <Text size="sm" c="dimmed">
            Sources:{" "}
            {deployment.sourceIds === null
              ? "all from the connection"
              : `${deployment.sourceIds.length} explicit`}
          </Text>
          <Text size="sm" c="dimmed">
            Monitors:{" "}
            {deployment.monitorIds === null
              ? "wildcard (all applicable, including future ones)"
              : `${deployment.monitorIds.length} explicit`}
          </Text>
        </Stack>
      </Card>

      {bundle ? (
        <BundleView bundle={bundle} />
      ) : (
        <Group justify="center" mt="xl">
          <Loader />
        </Group>
      )}
    </Container>
  );
}

function BundleView({ bundle }: { bundle: ApiTargetBundle }) {
  const tabs = bundle.files.map((f) => ({
    value: f.name,
    label: f.name,
    file: f,
  }));
  const [first] = tabs;
  return (
    <Stack gap="md">
      <Card withBorder p="lg">
        <Text size="sm" c="dimmed">
          Forwarding {bundle.selectedCount} source
          {bundle.selectedCount === 1 ? "" : "s"} · {bundle.monitorSummary}
        </Text>
      </Card>

      <Card withBorder p={0}>
        <Tabs defaultValue={first?.value}>
          <Tabs.List>
            {tabs.map((t) => (
              <Tabs.Tab key={t.value} value={t.value}>
                {t.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {tabs.map((t) => (
            <Tabs.Panel key={t.value} value={t.value} p="md">
              <FileBlock filename={t.file.name} content={t.file.content} />
            </Tabs.Panel>
          ))}
        </Tabs>
      </Card>

      <Card withBorder p="lg">
        <Title order={4} size="h5" mb="xs">
          Steps
        </Title>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <code>{bundle.selfDeployInstructions}</code>
        </pre>
      </Card>

      <Card withBorder p="lg">
        <Title order={4} size="h5" mb="sm">
          Environment variables
        </Title>
        <Stack gap="xs">
          {bundle.envVars.map((v) => (
            <Group key={v.name} justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Code>{v.name}</Code>
                <Text size="xs" c="dimmed">
                  {v.description}
                </Text>
              </Stack>
              {v.value !== null ? (
                <CopyButton value={v.value}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={copy}
                      leftSection={
                        copied ? (
                          <IconCheck size={12} />
                        ) : (
                          <IconCopy size={12} />
                        )
                      }
                    >
                      {copied ? "Copied" : "Copy value"}
                    </Button>
                  )}
                </CopyButton>
              ) : (
                <Text size="xs" c="dimmed">
                  set this yourself
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}

function FileBlock({
  filename,
  content,
}: {
  filename: string;
  content: string;
}) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Code>{filename}</Code>
        <CopyButton value={content}>
          {({ copied, copy }) => (
            <Button
              size="xs"
              variant="subtle"
              leftSection={
                copied ? <IconCheck size={14} /> : <IconCopy size={14} />
              }
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      </Group>
      <ScrollArea.Autosize mah={500}>
        <pre
          style={{
            margin: 0,
            padding: "12px",
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.5,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          <code>{content}</code>
        </pre>
      </ScrollArea.Autosize>
    </Stack>
  );
}
