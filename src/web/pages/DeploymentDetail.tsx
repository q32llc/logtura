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
  IconCloudUpload,
  IconCopy,
  IconDeviceFloppy,
  IconExternalLink,
  IconRocket,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  // URL-bound tab state so a refresh keeps you on the tab you were on.
  // ?action=deploy is the older link-in style — preserved for inbound
  // links from the deployments list / banner.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab =
    searchParams.get("tab") ??
    (searchParams.get("action") === "deploy" ? "run" : "overview");
  const setActiveTab = (v: string | null) => {
    if (!v) return;
    setSearchParams(
      (prev) => {
        prev.set("tab", v);
        // action=deploy is consumed once on landing; drop it so
        // subsequent reloads don't keep auto-firing the deploy.
        if (v !== "run") prev.delete("action");
        return prev;
      },
      { replace: true },
    );
  };
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
            {deployment.bundleOutdated && (
              <Badge variant="filled" color="orange">
                out of date
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

      {deployment.bundleOutdated && (
        <OutdatedBanner deployment={deployment} onRefresh={refetch} />
      )}

      <Tabs value={activeTab} onChange={setActiveTab}>
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

// ---------- Out-of-date banner -----------------------------------------

function OutdatedBanner({
  deployment,
  onRefresh,
}: {
  deployment: ApiDeployment;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<"deploy" | "mark" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function markDeployed() {
    setBusy("mark");
    setErr(null);
    try {
      await api.markDeploymentDeployed(deployment.id);
      notifications.show({ message: "Marked as deployed", color: "teal" });
      onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Alert color="orange" variant="light" mb="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Text fw={600}>This deployment is out of date</Text>
          <Text size="sm" c="dimmed">
            Something changed (token, monitor, sink, destination, source
            selection…) and the running container is still on the
            previous config. Redeploy to push the new bundle. If you
            already deployed this yourself, mark it as deployed to
            silence the warning.
          </Text>
          {err && (
            <Text size="xs" c="red.6">
              {err}
            </Text>
          )}
        </Stack>
        <Group gap="xs" wrap="nowrap">
          <Button
            component={Link}
            to={`/app/deployments/${deployment.id}?action=deploy`}
            color="orange"
            leftSection={<IconRocket size={14} />}
          >
            Redeploy
          </Button>
          <Button
            variant="default"
            onClick={markDeployed}
            loading={busy === "mark"}
          >
            Mark as deployed
          </Button>
        </Group>
      </Group>
    </Alert>
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

  // User-facing totals only count user-configured sources (for
  // "received") and sinks (for "sent" / "errors"). logtura's own
  // plumbing components (internal_metrics, heartbeat_pulse,
  // metrics_logtura, etc.) are excluded — they'd otherwise dwarf
  // real log traffic and made the headline read "6,632/min received"
  // even when zero actual events were flowing.
  const lifetime = userLifetime(snap);
  const totalRate = userRates(snap);
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

type SortKey = "id" | "kind" | "throughput" | "errors" | "lastSeen";
type SortDir = "asc" | "desc";

/** Pick the kind-appropriate counter for "events handled by this
 *  component" — sources track the events leaving them (.sent), sinks
 *  the events they delivered (.sent), transforms the events flowing
 *  in (.received). Reduces the table to one Throughput column so
 *  the user isn't reading two columns whose meaning shifts per row. */
function throughputCounter(c: ApiMetricsComponent): number | undefined {
  if (c.kind === "sink" || c.kind === "source") return c.sent;
  return c.received;
}
function throughputRate(c: ApiMetricsComponent): number | null {
  const r = perComponentRate(c);
  if (c.kind === "sink" || c.kind === "source") return r.sent;
  return r.received;
}

function PerComponentTable({
  snap,
  mode,
}: {
  snap: ApiMetricsSnapshot;
  mode: "rate" | "total";
}) {
  const [sortKey, setSortKey] = useState<SortKey>("throughput");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggle(k: SortKey) {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir(k === "id" || k === "kind" ? "asc" : "desc");
    }
  }

  const rows = Object.entries(snap.byComponent).map(([id, c]) => ({
    id,
    c,
    throughputN:
      mode === "rate"
        ? (throughputRate(c) ?? -1)
        : (throughputCounter(c) ?? -1),
    errN: mode === "rate"
      ? (perComponentRate(c).errors ?? -1)
      : (c.errors ?? -1),
  }));
  const kindRank: Record<string, number> = {
    source: 0,
    transform: 1,
    sink: 2,
    unknown: 3,
  };
  rows.sort((a, b) => {
    const cmp = (() => {
      switch (sortKey) {
        case "id":
          return a.id.localeCompare(b.id);
        case "kind": {
          const k = (kindRank[a.c.kind] ?? 9) - (kindRank[b.c.kind] ?? 9);
          return k !== 0 ? k : a.id.localeCompare(b.id);
        }
        case "throughput":
          return a.throughputN - b.throughputN;
        case "errors":
          return a.errN - b.errN;
        case "lastSeen":
          return a.c.lastSeen - b.c.lastSeen;
      }
    })();
    return sortDir === "asc" ? cmp : -cmp;
  });

  const Header = ({
    label,
    sk,
    width,
    align = "left",
  }: {
    label: string;
    sk: SortKey;
    width: number | "auto";
    align?: "left" | "right";
  }) => {
    const active = sortKey === sk;
    const arrow = active ? (sortDir === "asc" ? " ↑" : " ↓") : "";
    return (
      <Text
        size="xs"
        c={active ? undefined : "dimmed"}
        fw={active ? 600 : undefined}
        style={{
          flexBasis: width === "auto" ? undefined : width,
          flex: width === "auto" ? 1 : undefined,
          flexShrink: 0,
          textAlign: align,
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => toggle(sk)}
      >
        {label}
        {arrow}
      </Text>
    );
  };

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
        <Header label="Component" sk="id" width={220} />
        <Header label="Kind / type" sk="kind" width={140} />
        <Header label="Throughput" sk="throughput" width={130} align="right" />
        <Header label="Errors" sk="errors" width={90} align="right" />
        <Header label="Last seen" sk="lastSeen" width="auto" align="right" />
      </Group>
      {rows.map(({ id, c }) => {
        const tCount = throughputCounter(c);
        const tRate = throughputRate(c);
        const eCount = c.errors;
        const eRate = perComponentRate(c).errors;
        return (
          <Group key={id} gap="md" px="xs" py={2}>
            <Text size="xs" style={{ flexBasis: 220, flexShrink: 0 }} truncate>
              {id}
            </Text>
            <Text
              size="xs"
              c="dimmed"
              style={{ flexBasis: 140, flexShrink: 0 }}
              truncate
            >
              {c.kind} · {c.type}
            </Text>
            <Text
              size="xs"
              style={{ flexBasis: 130, flexShrink: 0, textAlign: "right" }}
            >
              {mode === "rate"
                ? tRate !== null
                  ? `${fmt1(tRate)}/min`
                  : "—"
                : tCount !== undefined
                  ? fmtN(tCount)
                  : "—"}
            </Text>
            <Text
              size="xs"
              c={(c.errors ?? 0) > 0 ? "red.5" : undefined}
              style={{ flexBasis: 90, flexShrink: 0, textAlign: "right" }}
            >
              {mode === "rate"
                ? eRate !== null
                  ? `${fmt1(eRate)}/min`
                  : "—"
                : eCount !== undefined
                  ? fmtN(eCount)
                  : "—"}
            </Text>
            <Text size="xs" c="dimmed" style={{ flex: 1, textAlign: "right" }}>
              {relativeTime(c.lastSeen)} ago
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

/** Component IDs the generator emits for logtura's own plumbing
 *  (heartbeat exec/sink, internal_metrics scrape, metrics_logtura
 *  sink, prom_heartbeat exporter). These flow events too — they're
 *  what made the headline look like "6,632/min received" when no
 *  actual logs were moving — but they aren't user log traffic and
 *  shouldn't count in the user-facing totals. The per-component
 *  table still shows them for debugging. */
const INTERNAL_COMPONENT_IDS = new Set([
  "internal_metrics",
  "prom_heartbeat",
  "heartbeat_pulse",
  "heartbeat_logtura",
  "metrics_logtura",
]);
function isInternalComponent(id: string): boolean {
  if (INTERNAL_COMPONENT_IDS.has(id)) return true;
  // metrics_<destination_id> — generated metric sinks when
  // metrics_target points at a destination.
  if (id.startsWith("metrics_")) return true;
  return false;
}

/** User-facing headline numbers. Only sources contribute to
 *  "received" (real log volume in), only sinks contribute to
 *  "sent" + "errors" (real delivery throughput / failures). Mixing
 *  in transforms or counting the same event at every stage is what
 *  made the numbers look unhinged. */
function userTotals(snap: ApiMetricsSnapshot) {
  let received = 0;
  let sent = 0;
  let errors = 0;
  for (const [id, c] of Object.entries(snap.byComponent)) {
    if (isInternalComponent(id)) continue;
    if (c.kind === "source") received += c.received ?? 0;
    if (c.kind === "sink") {
      sent += c.sent ?? 0;
      errors += c.errors ?? 0;
    }
  }
  return { received, sent, errors };
}

function userLifetime(snap: ApiMetricsSnapshot) {
  // Lifetime offsets are tracked across all components, so we can't
  // cleanly split them by kind retroactively. For now, surface the
  // current-process totals as "since this Vector started" and use
  // the global lifetime_offset as an indicator that a restart
  // occurred — the UI can footnote "events from before the last
  // restart aren't kind-aggregated."
  return userTotals(snap);
}

function userRates(snap: ApiMetricsSnapshot) {
  let received = 0;
  let sent = 0;
  let errors = 0;
  for (const [id, c] of Object.entries(snap.byComponent)) {
    if (isInternalComponent(id)) continue;
    const r = perComponentRate(c);
    if (c.kind === "source" && r.received !== null) received += r.received;
    if (c.kind === "sink") {
      if (r.sent !== null) sent += r.sent;
      if (r.errors !== null) errors += r.errors;
    }
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

      <SelfDeployCard deployment={deployment} />

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

// ---------- Self-deploy card -------------------------------------------
//
// One download button + one curl one-liner. The download is the simple
// path (browser → .tgz → untar → ./install.sh). The curl one-liner is
// for scripted/server-side installs: it embeds an HMAC-signed URL that
// expires in 60s.

function SelfDeployCard({ deployment }: { deployment: ApiDeployment }) {
  const [curlCmd, setCurlCmd] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Tick the "expires in N seconds" line so users see when they
  // need to regenerate.
  const [, force] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);

  async function generate() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await api.signInstallBundle(deployment.id);
      const cmd = `curl -fsSL ${shellEscape(r.url)} -o logtura.tgz && tar xzf logtura.tgz && cd logtura-* && ./install.sh`;
      setCurlCmd(cmd);
      setExpiresAt(r.expiresAt);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not sign URL");
    } finally {
      setBusy(false);
    }
  }

  const secondsLeft = expiresAt
    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    : null;
  const expired = secondsLeft !== null && secondsLeft === 0;

  return (
    <Card withBorder p="lg" radius="md">
      <Stack gap="md">
        <Stack gap={2}>
          <Group gap={6}>
            <Text fw={600}>Self-deploy</Text>
            <Badge size="xs" variant="light">
              you own the runtime
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            Download a single tarball, run <code>./install.sh</code>.
            Works on any host with Docker, Podman, or nerdctl —
            laptop, Raspberry Pi, your own Fly app, a Nomad cluster.
            Re-run after each "out of date" mark to push fresh config.
          </Text>
        </Stack>

        <Group>
          <Button
            component="a"
            href={api.installBundleUrl(deployment.id)}
            leftSection={<IconCloudUpload size={14} />}
            download
          >
            Download install bundle
          </Button>
          <Button
            variant="default"
            onClick={generate}
            loading={busy}
            disabled={expiresAt !== null && !expired}
            leftSection={<IconCopy size={14} />}
          >
            {curlCmd && !expired
              ? "Regenerate one-liner"
              : "Generate install one-liner"}
          </Button>
        </Group>

        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}

        {curlCmd && (
          <Stack gap={4}>
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                One-line install (expires in {secondsLeft}s, URL is
                single-shot)
              </Text>
              <CopyButton value={curlCmd}>
                {({ copy, copied: c }) => (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      copy();
                      setCopied(true);
                    }}
                    leftSection={
                      c ? <IconCheck size={12} /> : <IconCopy size={12} />
                    }
                  >
                    {c || copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: "var(--mantine-color-dark-7)",
                borderRadius: 6,
                fontSize: 12,
                overflow: "auto",
                opacity: expired ? 0.4 : 1,
              }}
            >
              <code>{curlCmd}</code>
            </pre>
            {expired && (
              <Text size="xs" c="dimmed">
                Link expired. Click Regenerate.
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function shellEscape(s: string): string {
  // For URLs we just stuff in single quotes; URLs won't contain
  // single quotes from us.
  return `'${s}'`;
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
  const [autoTriggered, setAutoTriggered] = useState(false);

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

  // ?action=deploy in the URL → auto-fire the deploy once targets
  // are loaded. This is what the "Redeploy" buttons on the
  // deployments list + the out-of-date banner link to: open the
  // detail page on the Run tab with deploy already in progress.
  useEffect(() => {
    if (autoTriggered) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("action") !== "deploy") return;
    if (targets === null) return; // wait for targets to load
    const flyTarget = targets.find(
      (t) => t.kind === "fly" && t.externalAccountId === "personal",
    );
    if (!flyTarget) return;
    setAutoTriggered(true);
    // Strip the query param so a refresh doesn't re-deploy.
    const url = new URL(window.location.href);
    url.searchParams.delete("action");
    window.history.replaceState({}, "", url.toString());
    void startDeploy(flyTarget.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, autoTriggered]);

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
