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
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDeviceFloppy,
  IconExternalLink,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { SelectionEditor } from "../components/SelectionEditor";
import type {
  ApiConnection,
  ApiDeployment,
  ApiMonitor,
  ApiSource,
  ApiTargetBundle,
} from "../types";

export function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<ApiDeployment | null>(null);
  const [bundle, setBundle] = useState<ApiTargetBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"delete" | null>(null);

  async function refetch() {
    if (!id) return;
    try {
      const [dep, bun] = await Promise.all([
        api.getDeployment(id),
        api.getDeploymentBundle(id),
      ]);
      setDeployment(dep.deployment);
      setBundle(bun);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <Tabs defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="configure">Configure</Tabs.Tab>
          <Tabs.Tab value="bundle">Bundle</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <OverviewPanel deployment={deployment} bundle={bundle} />
        </Tabs.Panel>

        <Tabs.Panel value="configure" pt="md">
          <ConfigurePanel deployment={deployment} onSaved={refetch} />
        </Tabs.Panel>

        <Tabs.Panel value="bundle" pt="md">
          {bundle ? (
            <BundleView bundle={bundle} />
          ) : (
            <Group justify="center" mt="xl">
              <Loader />
            </Group>
          )}
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}

// ---------- Overview ----------------------------------------------------

function OverviewPanel({
  deployment,
  bundle,
}: {
  deployment: ApiDeployment;
  bundle: ApiTargetBundle | null;
}) {
  const lastSeen = deployment.lastSeenAt
    ? new Date(deployment.lastSeenAt).toISOString()
    : null;
  return (
    <Stack gap="md">
      <Card withBorder p="lg">
        <Stack gap={6}>
          <Text fw={600}>Status</Text>
          <Text size="sm" c="dimmed">
            {bundle
              ? `Forwarding ${bundle.selectedCount} source${
                  bundle.selectedCount === 1 ? "" : "s"
                } · ${bundle.monitorSummary}`
              : "—"}
          </Text>
          <Text size="sm" c="dimmed">
            Last heartbeat:{" "}
            {lastSeen
              ? `${lastSeen} (${relativeTime(deployment.lastSeenAt!)})`
              : "never"}
          </Text>
        </Stack>
      </Card>

      <Card withBorder p="lg">
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
          <Text size="xs" c="dimmed" mt="xs">
            Use the Configure tab to change any of this. Changes apply to
            the next bundle fetch — you'll need to redeploy the running
            container to pick them up.
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}

// ---------- Configure ---------------------------------------------------

function ConfigurePanel({
  deployment,
  onSaved,
}: {
  deployment: ApiDeployment;
  onSaved: () => void;
}) {
  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [monitors, setMonitors] = useState<ApiMonitor[]>([]);

  const [name, setName] = useState(deployment.displayName);
  const [allSources, setAllSources] = useState(deployment.sourceIds === null);
  const [pickedSources, setPickedSources] = useState<Set<string>>(
    new Set(deployment.sourceIds ?? []),
  );
  const [allMonitors, setAllMonitors] = useState(
    deployment.monitorIds === null,
  );
  const [pickedMonitors, setPickedMonitors] = useState<Set<string>>(
    new Set(deployment.monitorIds ?? []),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getConnection(deployment.connectionId)
      .then((r) => {
        setConnection(r.connection);
        setSources(r.sources);
      })
      .catch(() => {});
    api
      .listMonitors()
      .then((r) => setMonitors(r.monitors))
      .catch(() => {});
  }, [deployment.connectionId]);

  // When the deployment row reloads (e.g. after Save), rehydrate local
  // state to match.
  useEffect(() => {
    setName(deployment.displayName);
    setAllSources(deployment.sourceIds === null);
    setPickedSources(new Set(deployment.sourceIds ?? []));
    setAllMonitors(deployment.monitorIds === null);
    setPickedMonitors(new Set(deployment.monitorIds ?? []));
  }, [deployment]);

  const applicableMonitors = useMemo(
    () =>
      monitors.filter(
        (m) =>
          m.connectionId === null || m.connectionId === deployment.connectionId,
      ),
    [monitors, deployment.connectionId],
  );

  const dirty =
    name.trim() !== deployment.displayName ||
    allSources !== (deployment.sourceIds === null) ||
    !setsEqual(pickedSources, new Set(deployment.sourceIds ?? [])) ||
    allMonitors !== (deployment.monitorIds === null) ||
    !setsEqual(pickedMonitors, new Set(deployment.monitorIds ?? []));

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.updateDeployment(deployment.id, {
        displayName: name.trim(),
        sourceIds: allSources ? null : [...pickedSources],
        monitorIds: allMonitors ? null : [...pickedMonitors],
      });
      notifications.show({ message: "Deployment updated", color: "teal" });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  function toggleSource(id: string, on: boolean) {
    setAllSources(false);
    setPickedSources((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleMonitor(id: string, on: boolean) {
    setAllMonitors(false);
    setPickedMonitors((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <Stack gap="md">
      <Card withBorder p="lg">
        <Stack gap="md">
          <TextInput
            label="Deployment name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          {connection && (
            <Text size="xs" c="dimmed">
              Connected to <strong>{connection.displayName}</strong> ·{" "}
              {connection.provider}
            </Text>
          )}
        </Stack>
      </Card>

      <Card withBorder p="lg">
        <SelectionEditor
          label={`Sources (${sources.length} discovered)`}
          hint="All sources are forwarded by default."
          all={allSources}
          onAll={(on) => {
            setAllSources(on);
            if (on) setPickedSources(new Set());
          }}
          items={sources.map((s) => ({
            id: s.id,
            label: s.displayName,
            sublabel: s.sourceKindLabel,
          }))}
          picked={pickedSources}
          toggle={toggleSource}
        />
      </Card>

      <Card withBorder p="lg">
        <SelectionEditor
          label={`Monitors (${applicableMonitors.length} applicable)`}
          hint="All applicable monitors apply by default. New monitors auto-apply unless you customize."
          all={allMonitors}
          onAll={(on) => {
            setAllMonitors(on);
            if (on) setPickedMonitors(new Set());
          }}
          items={applicableMonitors.map((m) => ({
            id: m.id,
            label: m.displayName,
            sublabel:
              m.filterSteps.length === 0
                ? "no filters"
                : `${m.filterSteps.length} step${m.filterSteps.length === 1 ? "" : "s"}`,
          }))}
          picked={pickedMonitors}
          toggle={toggleMonitor}
          empty={
            <Text size="sm" c="dimmed">
              No applicable monitors. Add one from the Monitors page.
            </Text>
          }
        />
      </Card>

      {err && (
        <Alert color="red" variant="light">
          {err}
        </Alert>
      )}

      <Group justify="flex-end">
        <Button
          onClick={save}
          loading={saving}
          disabled={!dirty || !name.trim()}
          leftSection={<IconDeviceFloppy size={16} />}
        >
          Save changes
        </Button>
      </Group>

      {dirty && (
        <Text size="xs" c="dimmed">
          Heads up: changes only apply when the running container picks
          up a new bundle. After saving, fetch the bundle again and
          redeploy.
        </Text>
      )}
    </Stack>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function relativeTime(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- Bundle (existing) ------------------------------------------

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
                {v.staleReason && (
                  <Text size="xs" c="red.4" mt={2}>
                    Stored credential is unusable ({v.staleReason}). Get a new
                    one and re-add the connection.
                  </Text>
                )}
                {v.credentialExpiresAt !== undefined &&
                  v.credentialExpiresAt !== null &&
                  !v.staleReason && (
                    <Text
                      size="xs"
                      c={expiryColor(v.credentialExpiresAt)}
                      mt={2}
                    >
                      {formatExpiry(v.credentialExpiresAt)}
                    </Text>
                  )}
                {v.helpUrl && (
                  <Button
                    component="a"
                    href={v.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconExternalLink size={10} />}
                    style={{
                      alignSelf: "flex-start",
                      paddingLeft: 0,
                      marginTop: 2,
                    }}
                  >
                    create a new one
                  </Button>
                )}
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
              ) : v.helpUrl ? (
                <Button
                  component="a"
                  href={v.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  variant={v.staleReason ? "filled" : "default"}
                  color={v.staleReason ? "red" : undefined}
                  leftSection={<IconExternalLink size={12} />}
                >
                  Create one
                </Button>
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

function formatExpiry(ms: number): string {
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "Expired";
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days < 1) {
    const hours = Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)));
    return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (days < 60) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  return `Expires in ~${months} month${months === 1 ? "" : "s"} (${new Date(ms).toISOString().slice(0, 10)})`;
}

function expiryColor(ms: number): string {
  const days = (ms - Date.now()) / (24 * 60 * 60 * 1000);
  if (days <= 7) return "red.4";
  if (days <= 30) return "yellow.6";
  return "dimmed";
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
