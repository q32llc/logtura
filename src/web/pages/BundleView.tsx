import {
  Alert,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
  Container,
} from "@mantine/core";
import { IconArrowLeft, IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type { ApiBundle } from "../types";

export function BundleView() {
  const { id } = useParams<{ id: string }>();
  const [bundle, setBundle] = useState<ApiBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getBundle(id)
      .then(setBundle)
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load bundle"),
      );
  }, [id]);

  if (error) {
    return (
      <Container size="md">
        <Alert color="red">{error}</Alert>
      </Container>
    );
  }

  if (!bundle) {
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
      <Group justify="space-between" mb="lg">
        <Stack gap={4}>
          <Title order={1}>Forwarder bundle</Title>
          <Text size="sm" c="dimmed">
            Forwarding {bundle.selectedCount} source
            {bundle.selectedCount === 1 ? "" : "s"}. Save these files into
            an empty directory.
          </Text>
        </Stack>
        <Button
          component={Link}
          to={`/app/connections/${id}`}
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
        >
          Back
        </Button>
      </Group>

      <Tabs defaultValue="dockerfile">
        <Tabs.List>
          <Tabs.Tab value="dockerfile">Dockerfile</Tabs.Tab>
          <Tabs.Tab value="vector">vector.yaml</Tabs.Tab>
          <Tabs.Tab value="run">Run command</Tabs.Tab>
          <Tabs.Tab value="env">Environment variables</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="dockerfile" pt="md">
          <FileBlock content={bundle.dockerfile} filename="Dockerfile" />
        </Tabs.Panel>
        <Tabs.Panel value="vector" pt="md">
          <FileBlock content={bundle.vectorYaml} filename="vector.yaml" />
        </Tabs.Panel>
        <Tabs.Panel value="run" pt="md">
          <FileBlock content={bundle.runCommand} filename="run.sh" />
        </Tabs.Panel>
        <Tabs.Panel value="env" pt="md">
          <Card withBorder p="md">
            <Stack gap="sm">
              {bundle.envVars.map((v) => (
                <Stack key={v.name} gap={2}>
                  <Code>{v.name}</Code>
                  <Text size="sm" c="dimmed">
                    {v.description}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}

function FileBlock({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  return (
    <Card withBorder p={0}>
      <Group justify="space-between" px="md" py="xs">
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
      <pre
        style={{
          margin: 0,
          padding: "16px",
          borderTop: "1px solid var(--mantine-color-default-border)",
          fontSize: 13,
          lineHeight: 1.5,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          overflowX: "auto",
        }}
      >
        <code>{content}</code>
      </pre>
    </Card>
  );
}
