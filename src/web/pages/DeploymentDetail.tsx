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
  Select,
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
  IconRocket,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { SelectionEditor } from "../components/SelectionEditor";
import type {
  ApiConnection,
  ApiDeployTarget,
  ApiDeployment,
  ApiDestination,
  ApiJob,
  ApiMetricsComponent,
  ApiMetricsSnapshot,
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
          <Tabs.Tab value="run">Run</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <OverviewPanel deployment={deployment} bundle={bundle} />
        </Tabs.Panel>

        <Tabs.Panel value="configure" pt="md">
          <ConfigurePanel deployment={deployment} onSaved={refetch} />
        </Tabs.Panel>

        <Tabs.Panel value="run" pt="md">
          <RunPanel deployment={deployment} bundle={bundle} />
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

      <MetricsCard deployment={deployment} />

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

// ---------- Metrics (headline + per-component drilldown) ----------------

function MetricsCard({ deployment }: { deployment: ApiDeployment }) {
  const [mode, setMode] = useState<"rate" | "total">("rate");
  const [expanded, setExpanded] = useState(false);
  const snap = deployment.metricsSnapshot;

  if (!snap || snap.updatedAt === 0) {
    return (
      <Card withBorder p="lg">
        <Stack gap={4}>
          <Text fw={600}>Pipeline metrics</Text>
          <Text size="sm" c="dimmed">
            {deployment.metricsTarget && deployment.metricsTarget !== "none"
              ? "Waiting for the first metrics POST from the forwarder. Vector scrapes its own internals every 30s."
              : 'No metrics target configured. Set metrics_target to "logtura" on the Configure tab to see counters here.'}
          </Text>
        </Stack>
      </Card>
    );
  }

  // Lifetime = current totals + lifetime_offset (counters that
  // survived previous restarts).
  const lifetime = {
    received: snap.totals.received + snap.lifetimeOffset.received,
    sent: snap.totals.sent + snap.lifetimeOffset.sent,
    errors: snap.totals.errors + snap.lifetimeOffset.errors,
    discarded: snap.totals.discarded + snap.lifetimeOffset.discarded,
  };
  // Rate = sum of per-component rates for received/sent/errors.
  const totalRate = sumRates(snap);
  const display =
    mode === "rate"
      ? {
          received: totalRate.received,
          sent: totalRate.sent,
          errors: totalRate.errors,
        }
      : {
          received: lifetime.received,
          sent: lifetime.sent,
          errors: lifetime.errors,
        };

  return (
    <Card withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap={6}>
            <Text fw={600}>Pipeline metrics</Text>
            {snap.vectorVersion && (
              <Badge size="xs" variant="light">
                Vector {snap.vectorVersion}
              </Badge>
            )}
          </Group>
          <Group gap={4}>
            <Button
              size="compact-xs"
              variant={mode === "rate" ? "filled" : "default"}
              onClick={() => setMode("rate")}
            >
              Rate
            </Button>
            <Button
              size="compact-xs"
              variant={mode === "total" ? "filled" : "default"}
              onClick={() => setMode("total")}
            >
              Total
            </Button>
          </Group>
        </Group>

        <Group gap="xl" wrap="nowrap">
          <Stack gap={0}>
            <Text size="xs" c="dimmed">
              Events received
            </Text>
            <Text fw={700} size="xl">
              {mode === "rate"
                ? `${fmt1(display.received)} /min`
                : fmtN(display.received)}
            </Text>
          </Stack>
          <Stack gap={0}>
            <Text size="xs" c="dimmed">
              Events sent
            </Text>
            <Text fw={700} size="xl">
              {mode === "rate"
                ? `${fmt1(display.sent)} /min`
                : fmtN(display.sent)}
            </Text>
          </Stack>
          <Stack gap={0}>
            <Text size="xs" c="dimmed">
              Errors
            </Text>
            <Text fw={700} size="xl" c={display.errors > 0 ? "red.5" : undefined}>
              {mode === "rate"
                ? `${fmt1(display.errors)} /min`
                : fmtN(display.errors)}
            </Text>
          </Stack>
        </Group>

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Last metrics{" "}
            {snap.updatedAt
              ? `${relativeTime(snap.updatedAt)} ago`
              : "never"}
            {snap.processStartAt
              ? ` · Vector booted ${relativeTime(snap.processStartAt)} ago`
              : ""}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? "Hide per-component"
              : `Show per-component (${Object.keys(snap.byComponent).length})`}
          </Button>
        </Group>

        {expanded && <PerComponentTable snap={snap} mode={mode} />}
      </Stack>
    </Card>
  );
}

function PerComponentTable({
  snap,
  mode,
}: {
  snap: ApiMetricsSnapshot;
  mode: "rate" | "total";
}) {
  const rows = Object.entries(snap.byComponent)
    .map(([id, c]) => {
      const rate = perComponentRate(c);
      return { id, c, rate };
    })
    .sort((a, b) => {
      // Sort sources first, then transforms, then sinks; within
      // each kind, by id.
      const kindRank: Record<string, number> = {
        source: 0,
        transform: 1,
        sink: 2,
        unknown: 3,
      };
      const k = (kindRank[a.c.kind] ?? 9) - (kindRank[b.c.kind] ?? 9);
      return k !== 0 ? k : a.id.localeCompare(b.id);
    });

  return (
    <Stack gap={2} mt="xs">
      <Group
        gap="md"
        px="xs"
        py={4}
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Text size="xs" c="dimmed" style={{ flexBasis: 220, flexShrink: 0 }}>
          Component
        </Text>
        <Text size="xs" c="dimmed" style={{ flexBasis: 100, flexShrink: 0 }}>
          Kind / type
        </Text>
        <Text
          size="xs"
          c="dimmed"
          style={{ flexBasis: 110, flexShrink: 0, textAlign: "right" }}
        >
          Received
        </Text>
        <Text
          size="xs"
          c="dimmed"
          style={{ flexBasis: 110, flexShrink: 0, textAlign: "right" }}
        >
          Sent
        </Text>
        <Text
          size="xs"
          c="dimmed"
          style={{ flexBasis: 80, flexShrink: 0, textAlign: "right" }}
        >
          Errors
        </Text>
        <Text size="xs" c="dimmed" style={{ flex: 1, textAlign: "right" }}>
          Last seen
        </Text>
      </Group>
      {rows.map(({ id, c, rate }) => (
        <Group key={id} gap="md" px="xs" py={2}>
          <Text size="xs" style={{ flexBasis: 220, flexShrink: 0 }} truncate>
            {id}
          </Text>
          <Text
            size="xs"
            c="dimmed"
            style={{ flexBasis: 100, flexShrink: 0 }}
            truncate
          >
            {c.kind} · {c.type}
          </Text>
          <Text
            size="xs"
            style={{ flexBasis: 110, flexShrink: 0, textAlign: "right" }}
          >
            {mode === "rate"
              ? rate.received !== null
                ? `${fmt1(rate.received)}/min`
                : "—"
              : c.received !== undefined
                ? fmtN(c.received)
                : "—"}
          </Text>
          <Text
            size="xs"
            style={{ flexBasis: 110, flexShrink: 0, textAlign: "right" }}
          >
            {mode === "rate"
              ? rate.sent !== null
                ? `${fmt1(rate.sent)}/min`
                : "—"
              : c.sent !== undefined
                ? fmtN(c.sent)
                : "—"}
          </Text>
          <Text
            size="xs"
            c={(c.errors ?? 0) > 0 ? "red.5" : undefined}
            style={{ flexBasis: 80, flexShrink: 0, textAlign: "right" }}
          >
            {mode === "rate"
              ? rate.errors !== null
                ? `${fmt1(rate.errors)}/min`
                : "—"
              : c.errors !== undefined
                ? fmtN(c.errors)
                : "—"}
          </Text>
          <Text size="xs" c="dimmed" style={{ flex: 1, textAlign: "right" }}>
            {relativeTime(c.lastSeen)} ago
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function sumRates(snap: ApiMetricsSnapshot) {
  let received = 0;
  let sent = 0;
  let errors = 0;
  for (const c of Object.values(snap.byComponent)) {
    const r = perComponentRate(c);
    if (r.received !== null) received += r.received;
    if (r.sent !== null) sent += r.sent;
    if (r.errors !== null) errors += r.errors;
  }
  return { received, sent, errors };
}

function perComponentRate(c: ApiMetricsComponent) {
  const rate = (
    field: "received" | "sent" | "errors" | "discarded",
  ): number | null => {
    const cur = c[field];
    const prev = c.prev?.[field];
    if (cur === undefined || prev === undefined || !c.prev) return null;
    const dt = c.lastSeen - c.prev.sampleAt;
    if (dt <= 0) return null;
    const dv = cur - prev;
    if (dv < 0) return 0;
    return (dv * 60_000) / dt;
  };
  return {
    received: rate("received"),
    sent: rate("sent"),
    errors: rate("errors"),
    discarded: rate("discarded"),
  };
}

function fmt1(n: number): string {
  if (n === 0) return "0";
  if (n < 0.1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function fmtN(n: number): string {
  return Math.round(n).toLocaleString();
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
  const [destinations, setDestinations] = useState<ApiDestination[]>([]);

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
  // null → default ("logtura"). UI normalizes to "logtura" / "none".
  const [heartbeatTarget, setHeartbeatTarget] = useState<string>(
    deployment.heartbeatTarget ?? "logtura",
  );
  const [metricsTarget, setMetricsTarget] = useState<string>(
    deployment.metricsTarget ?? "none",
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
    api
      .listDestinations()
      .then((r) => setDestinations(r.destinations))
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
    setHeartbeatTarget(deployment.heartbeatTarget ?? "logtura");
    setMetricsTarget(deployment.metricsTarget ?? "none");
  }, [deployment]);

  const applicableMonitors = useMemo(
    () =>
      monitors.filter(
        (m) =>
          m.connectionId === null || m.connectionId === deployment.connectionId,
      ),
    [monitors, deployment.connectionId],
  );

  const metricsDestinations = useMemo(
    () => destinations.filter((d) => d.flows.includes("metrics")),
    [destinations],
  );

  const dirty =
    name.trim() !== deployment.displayName ||
    allSources !== (deployment.sourceIds === null) ||
    !setsEqual(pickedSources, new Set(deployment.sourceIds ?? [])) ||
    allMonitors !== (deployment.monitorIds === null) ||
    !setsEqual(pickedMonitors, new Set(deployment.monitorIds ?? [])) ||
    heartbeatTarget !== (deployment.heartbeatTarget ?? "logtura") ||
    metricsTarget !== (deployment.metricsTarget ?? "none");

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.updateDeployment(deployment.id, {
        displayName: name.trim(),
        sourceIds: allSources ? null : [...pickedSources],
        monitorIds: allMonitors ? null : [...pickedMonitors],
        heartbeatTarget,
        metricsTarget: metricsTarget === "none" ? null : metricsTarget,
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

      <Card withBorder p="lg">
        <Stack gap="md">
          <Stack gap={2}>
            <Text fw={600}>Liveness signal</Text>
            <Text size="xs" c="dimmed">
              The container POSTs a heartbeat every 30s so logtura knows
              it's alive. logtura records the last-seen timestamp only.
            </Text>
          </Stack>
          <Select
            label="Heartbeat target"
            value={heartbeatTarget}
            onChange={(v) => v && setHeartbeatTarget(v)}
            data={[
              { value: "logtura", label: "logtura (recommended)" },
              { value: "none", label: "None (no liveness checks)" },
            ]}
            allowDeselect={false}
          />

          <Stack gap={2}>
            <Text fw={600}>Metrics export</Text>
            <Text size="xs" c="dimmed">
              Vector's internal metrics (events received, sent, errors).
              Pick "logtura" for last-received tracking only — for graphs
              and alerts, send to a metrics destination instead.
            </Text>
          </Stack>
          <Select
            label="Metrics target"
            value={metricsTarget}
            onChange={(v) => v && setMetricsTarget(v)}
            data={[
              { value: "none", label: "None (don't export metrics)" },
              { value: "logtura", label: "logtura (last-received only)" },
              ...metricsDestinations.map((d) => ({
                value: d.id,
                label: `${d.displayName} (${d.kind})`,
              })),
            ]}
            allowDeselect={false}
          />
          {metricsDestinations.length === 0 && (
            <Text size="xs" c="dimmed">
              No metrics-capable destinations configured. Add a Datadog
              or Prometheus remote-write destination from the
              Destinations page to enable graphs.
            </Text>
          )}
        </Stack>
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

// ---------- Run (managed deploy + self-deploy bundle, equal weight) ----

function RunPanel({
  deployment,
  bundle,
}: {
  deployment: ApiDeployment;
  bundle: ApiTargetBundle | null;
}) {
  return (
    <Stack gap="lg">
      <ManagedDeployCard deployment={deployment} />

      <Card withBorder p="lg" radius="md">
        <Stack gap="sm">
          <Group gap={6}>
            <Text fw={600}>Self-deploy</Text>
            <Badge size="xs" variant="light">
              you own the runtime
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            Grab the generated Dockerfile + Vector config and run the
            forwarder anywhere — your laptop, your own Fly app, a Nomad
            cluster, a Raspberry Pi. logtura keeps generating the
            config; you decide where it lives.
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
    </Stack>
  );
}

function ManagedDeployCard({ deployment }: { deployment: ApiDeployment }) {
  const [targets, setTargets] = useState<ApiDeployTarget[] | null>(null);
  const [connecting, setConnecting] = useState<{
    sessionId: string;
    authUrl: string;
  } | null>(null);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployJob, setDeployJob] = useState<ApiJob | null>(null);
  const [deploying, setDeploying] = useState(false);

  async function refetch() {
    try {
      const r = await api.listDeployTargets();
      setTargets(r.deployTargets);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  // Poll the connect endpoint while a session is in progress.
  useEffect(() => {
    if (!connecting) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.flyConnectPoll(connecting.sessionId);
        if (cancelled) return;
        if (r.status === "connected") {
          setConnecting(null);
          setPollMessage(`Connected as ${r.displayName}`);
          await refetch();
          return;
        }
        setTimeout(tick, 2000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Polling failed");
        setConnecting(null);
      }
    };
    setTimeout(tick, 2000);
    return () => {
      cancelled = true;
    };
  }, [connecting]);

  // Poll the deploy job until it terminates.
  useEffect(() => {
    if (!deployJob) return;
    if (deployJob.status === "succeeded" || deployJob.status === "failed") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.getJob(deployJob.id);
        if (cancelled) return;
        setDeployJob(r.job);
        if (r.job.status === "queued" || r.job.status === "running") {
          setTimeout(tick, 2000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Job poll failed");
      }
    };
    setTimeout(tick, 2000);
    return () => {
      cancelled = true;
    };
  }, [deployJob]);

  async function startConnect() {
    setError(null);
    setPollMessage(null);
    try {
      const r = await api.flyConnectStart();
      window.open(r.authUrl, "_blank", "noopener,noreferrer");
      setConnecting({ sessionId: r.sessionId, authUrl: r.authUrl });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to start connect");
    }
  }

  async function startDeploy(targetId: string) {
    setError(null);
    setDeploying(true);
    try {
      const r = await api.deployNow(deployment.id, { deployTargetId: targetId });
      setDeployJob(r.job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to start deploy");
    } finally {
      setDeploying(false);
    }
  }

  if (deployment.targetKind === "other") {
    return (
      <Card withBorder p="lg" radius="md">
        <Stack gap="sm">
          <Group gap={6}>
            <IconRocket size={18} />
            <Text fw={600}>Managed deploy</Text>
          </Group>
          <Text size="sm" c="dimmed">
            You picked Other as the target, so logtura doesn't know
            where to push the forwarder. Self-deploy below works
            anywhere; switch the target on the Configure tab if you
            want a one-click deploy.
          </Text>
        </Stack>
      </Card>
    );
  }

  if (deployment.targetKind !== "fly") {
    return (
      <Card withBorder p="lg" radius="md">
        <Stack gap="sm">
          <Group gap={6}>
            <IconRocket size={18} />
            <Text fw={600}>
              Managed deploy for {deployment.targetKind}: coming next
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Fly is up; the click-flow for this target lands soon.
            Self-deploy below works today.
          </Text>
        </Stack>
      </Card>
    );
  }

  const flyTarget =
    targets?.find(
      (t) => t.kind === "fly" && t.externalAccountId === "personal",
    ) ?? null;

  return (
    <Card withBorder p="lg" radius="md">
      <Stack gap="md">
        <Group gap={6}>
          <IconRocket size={18} />
          <Text fw={600}>Managed deploy on Fly</Text>
          <Badge size="xs" variant="light" color="teal">
            we run it for you
          </Badge>
        </Group>

        {error && <Alert color="red">{error}</Alert>}
        {pollMessage && !error && (
          <Alert color="teal" variant="light">
            {pollMessage}
          </Alert>
        )}

        {targets === null ? (
          <Loader size="xs" />
        ) : flyTarget ? (
          <FlyDeployRunner
            target={flyTarget}
            deployJob={deployJob}
            deploying={deploying}
            onDeploy={() => startDeploy(flyTarget.id)}
            onReconnect={startConnect}
            connecting={connecting !== null}
          />
        ) : connecting ? (
          <ConnectingState
            authUrl={connecting.authUrl}
            onCancel={() => setConnecting(null)}
          />
        ) : (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Click below to authorize logtura to deploy on your Fly
              account. Same flow flyctl uses for{" "}
              <code>fly auth login</code>: we open Fly's auth page, you
              approve, the token comes back here.
            </Text>
            <Group>
              <Button
                onClick={startConnect}
                leftSection={<IconExternalLink size={14} />}
              >
                Connect Fly
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function ConnectingState({
  authUrl,
  onCancel,
}: {
  authUrl: string;
  onCancel: () => void;
}) {
  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm">
          Waiting for Fly approval — open the auth tab if it didn't pop
          up.
        </Text>
      </Group>
      <Group>
        <Button
          component="a"
          href={authUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
          variant="default"
          leftSection={<IconExternalLink size={12} />}
        >
          Open Fly auth
        </Button>
        <Button size="xs" variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

function FlyDeployRunner({
  target,
  deployJob,
  deploying,
  onDeploy,
  onReconnect,
  connecting,
}: {
  target: ApiDeployTarget;
  deployJob: ApiJob | null;
  deploying: boolean;
  onDeploy: () => void;
  onReconnect: () => void;
  connecting: boolean;
}) {
  const result = (deployJob?.result ?? null) as {
    appName?: string;
    appUrl?: string;
    machineId?: string;
    region?: string;
  } | null;

  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Text size="sm">
          Connected as <strong>{target.displayName}</strong>
        </Text>
        <Text size="xs" c="dimmed">
          Token saved{" "}
          {new Date(target.updatedAt).toISOString().slice(0, 10)}. Re-running
          connect rotates the token in place.
        </Text>
      </Stack>

      {deployJob && deployJob.status !== "succeeded" && (
        <Alert
          color={deployJob.status === "failed" ? "red" : "blue"}
          variant="light"
        >
          {deployJob.status === "failed"
            ? `Deploy failed: ${deployJob.error ?? "unknown"}`
            : `Deploying… (${deployJob.status})`}
        </Alert>
      )}

      {deployJob?.status === "succeeded" && result?.appUrl && (
        <Alert color="teal" variant="light">
          <Stack gap={2}>
            <Text size="sm" fw={600}>
              Deployed to Fly: {result.appName}
            </Text>
            <Text size="xs">
              Machine {result.machineId} in {result.region}.
            </Text>
            <Group gap="xs" mt={4}>
              <Button
                component="a"
                href={result.appUrl}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                variant="default"
                leftSection={<IconExternalLink size={12} />}
              >
                Open on fly.io
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      <Group>
        <Button
          onClick={onDeploy}
          loading={
            deploying ||
            deployJob?.status === "queued" ||
            deployJob?.status === "running"
          }
          leftSection={<IconRocket size={14} />}
        >
          {deployJob?.status === "succeeded" ? "Redeploy" : "Deploy now"}
        </Button>
        <Button
          size="xs"
          variant="default"
          onClick={onReconnect}
          loading={connecting}
        >
          Reconnect Fly
        </Button>
      </Group>

      <Text size="xs" c="dimmed">
        Logtura keeps the deployed forwarder running. Container logic
        lives in your Fly account, so disconnecting from logtura leaves
        it running until you tear it down on Fly.
      </Text>
    </Stack>
  );
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
