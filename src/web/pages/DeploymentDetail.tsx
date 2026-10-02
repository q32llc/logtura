import { rateFor } from "@logtura/core";
import { DeploymentRevisionStatus } from "../components/DeploymentRevisionStatus";
import { deploymentSourceSummary } from "../deployment-selection";
import {
  Alert,
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Container,
  CopyButton,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCloudUpload,
  IconCopy,
  IconDeviceFloppy,
  IconExternalLink,
  IconRocket,
  IconTrash,
} from "@tabler/icons-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { SelectionEditor } from "../components/SelectionEditor";
import type {
  ApiComponentManifestEntry,
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
  const [configurationRefreshKey,setConfigurationRefreshKey]=useState(0);
  const [bundle, setBundle] = useState<ApiTargetBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"delete" | null>(null);
  // Server returns any queued/running deploy job for this deployment so
  // a hard refresh mid-deploy can pick polling back up. We seed
  // ManagedDeployCard with this once, then it owns the state.
  const [initialDeployJob, setInitialDeployJob] = useState<ApiJob | null>(
    null,
  );

  async function refetch() {
    if (!id) return;
    try {
      const [dep, bun] = await Promise.all([
        api.getDeployment(id),
        api.getDeploymentBundle(id),
      ]);
      setDeployment(dep.deployment);
      setBundle(bun);
      setInitialDeployJob(dep.latestDeployJob);
      setConfigurationRefreshKey(value=>value+1);
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

      <DeploymentRevisionStatus deploymentId={deployment.id} refreshKey={configurationRefreshKey}/>

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
          <RunPanel
            deployment={deployment}
            bundle={bundle}
            initialDeployJob={initialDeployJob}
            onRefresh={refetch}
          />
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

  function handleRedeployClick(event: MouseEvent<HTMLAnchorElement>) {
    if (busy === "deploy") {
      event.preventDefault();
      return;
    }
    setBusy("deploy");
  }

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
            loading={busy === "deploy"}
            onClick={handleRedeployClick}
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

      <MetricsCard
        deployment={deployment}
        manifest={bundle?.componentManifest ?? []}
      />

      <Card withBorder p="lg">
        <Stack gap={6}>
          <Text fw={600}>Selection</Text>
          <Text size="sm" c="dimmed">
            Sources:{" "}
            {deploymentSourceSummary(deployment)}
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

function MetricsCard({
  deployment,
  manifest,
}: {
  deployment: ApiDeployment;
  manifest: ApiComponentManifestEntry[];
}) {
  const [mode, setMode] = useState<"rate" | "total">("rate");
  const [expanded, setExpanded] = useState(false);
  const [showPlumbing, setShowPlumbing] = useState(false);
  const snap = deployment.metricsSnapshot;
  const manifestById = useMemo(() => {
    const m = new Map<string, ApiComponentManifestEntry>();
    for (const e of manifest) m.set(e.id, e);
    return m;
  }, [manifest]);

  if (!snap || snap.updatedAt === 0) {
    return (
      <Card withBorder p="lg" component="section" aria-label="Pipeline metrics">
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
  const lifetime = userLifetime(snap, manifestById);
  const totalRate = userRates(snap, manifestById);
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
    <Card withBorder p="lg" component="section" aria-label="Pipeline metrics">
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

        {mode === "total" && <Text size="xs" c="dimmed">Totals since the current Vector process started.</Text>}

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Last metrics{" "}
            {snap.updatedAt
              ? relativeTime(snap.updatedAt)
              : "never"}
            {snap.processStartAt
              ? ` · Vector booted ${relativeTime(snap.processStartAt)}`
              : ""}
          </Text>
          <Group gap="md">
            {expanded && (
              <Checkbox
                size="xs"
                label="Show plumbing"
                checked={showPlumbing}
                onChange={(e) => setShowPlumbing(e.currentTarget.checked)}
              />
            )}
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
        </Group>

        {expanded && (
          <PerComponentTable
            snap={snap}
            mode={mode}
            manifestById={manifestById}
            showPlumbing={showPlumbing}
          />
        )}
      </Stack>
    </Card>
  );
}

/** Pick the kind-appropriate counter for "events handled by this
 *  component" — sources track the events leaving them (.sent), sinks
 *  the events they delivered (.sent), transforms the events flowing
 *  in (.received). Reduces the table to one Throughput column so
 *  the user isn't reading two columns whose meaning shifts per row. */
/** Format errorsByType as a multiline tooltip body. Sorted by count
 *  desc so the dominant failure mode is on top. */
function errorsByTypeTooltip(c: ApiMetricsComponent): string {
  const t = c.errorsByType;
  if (!t || Object.keys(t).length === 0) return "";
  const lines = Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}: ${n.toLocaleString()}`);
  return lines.join("\n");
}

function throughputCounter(
  c: ApiMetricsComponent,
  manifest?: ApiComponentManifestEntry | null,
): number | undefined {
  if (manifest?.role === "source" || manifest?.role === "sink") return c.sent;
  if (c.kind === "sink" || c.kind === "source") return c.sent;
  return c.received;
}
function throughputRate(
  c: ApiMetricsComponent,
  manifest?: ApiComponentManifestEntry | null,
): number | null {
  const r = perComponentRate(c);
  if (manifest?.role === "source" || manifest?.role === "sink") return r.sent;
  if (c.kind === "sink" || c.kind === "source") return r.sent;
  return r.received;
}

interface ComponentRow {
  id: string;
  c: ApiMetricsComponent;
  manifest: ApiComponentManifestEntry | null;
  parentId: string | null;
  throughputN: number;
}

function PerComponentTable({
  snap,
  mode,
  manifestById,
  showPlumbing,
}: {
  snap: ApiMetricsSnapshot;
  mode: "rate" | "total";
  manifestById: Map<string, ApiComponentManifestEntry>;
  showPlumbing: boolean;
}) {
  // Rows live in three buckets so we can render section headers and
  // toggle plumbing visibility without disturbing the table layout.
  // Components Vector reports that the manifest doesn't know about
  // (shouldn't happen if generator + container are in sync, but
  // bundle_outdated races make it possible) fall through to a
  // "Plumbing" bucket so we never silently drop a row.
  const { sources, sinks, plumbing } = useMemo(() => {
    const sources: ComponentRow[] = [];
    const sinks: ComponentRow[] = [];
    const plumbing: ComponentRow[] = [];
    for (const [id, c] of Object.entries(snap.byComponent)) {
      const manifest = manifestById.get(id) ?? null;
      const throughputN =
        mode === "rate"
          ? (throughputRate(c, manifest) ?? -1)
          : (throughputCounter(c, manifest) ?? -1);
      const row: ComponentRow = {
        id,
        c,
        manifest,
        parentId: manifest?.links?.parentId ?? null,
        throughputN,
      };
      if (manifest?.role === "source") sources.push(row);
      else if (manifest?.role === "sink") sinks.push(row);
      else plumbing.push(row);
    }
    const byThroughput = (a: ComponentRow, b: ComponentRow) =>
      b.throughputN - a.throughputN;
    sources.sort(byThroughput);
    sinks.sort(byThroughput);
    plumbing.sort(byThroughput);
    return { sources, sinks, plumbing };
  }, [snap.byComponent, manifestById, mode]);

  return (
    <Stack gap="md" mt="xs">
      <Section title="Sources" count={sources.length} rows={sources} mode={mode} />
      <Section title="Sinks" count={sinks.length} rows={sinks} mode={mode} />
      {showPlumbing && (
        <Section
          title="Internal plumbing"
          count={plumbing.length}
          rows={plumbing}
          mode={mode}
        />
      )}
    </Stack>
  );
}

function Section({
  title,
  count,
  rows,
  mode,
}: {
  title: string;
  count: number;
  rows: ComponentRow[];
  mode: "rate" | "total";
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { topRows, childrenByParent } = useMemo(() => {
    const childMap = new Map<string, ComponentRow[]>();
    const top: ComponentRow[] = [];
    const ids = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId)) {
        const children = childMap.get(row.parentId) ?? [];
        children.push(row);
        childMap.set(row.parentId, children);
      } else {
        top.push(row);
      }
    }
    for (const children of childMap.values()) {
      children.sort((a, b) => b.throughputN - a.throughputN);
    }
    return { topRows: top, childrenByParent: childMap };
  }, [rows]);

  if (count === 0) {
    return (
      <Stack gap={4}>
        <Group gap={8}>
          <Text fw={600} size="sm">
            {title}
          </Text>
          <Badge size="xs" variant="light">
            0
          </Badge>
        </Group>
        <Text size="xs" c="dimmed" pl={4}>
          (none)
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap={4}>
      <Group gap={8}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Badge size="xs" variant="light">
          {count}
        </Badge>
      </Group>
      <Table
        aria-label={`${title} metrics`}
        striped
        verticalSpacing={4}
        horizontalSpacing="xs"
        layout="fixed"
        style={{ fontSize: "var(--mantine-font-size-xs)" }}
      >
        <colgroup>
          <col />
          <col style={{ width: 140 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 110 }} />
        </colgroup>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Component</Table.Th>
            <Table.Th>Detail</Table.Th>
            <Table.Th ta="right">Throughput</Table.Th>
            <Table.Th ta="right">Errors</Table.Th>
            <Table.Th ta="right">Last seen</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {topRows.map((row) => {
            const children = childrenByParent.get(row.id) ?? [];
            const isExpanded = expanded[row.id] ?? true;
            return [
              <ComponentTableRow
                key={row.id}
                row={row}
                mode={mode}
                hasChildren={children.length > 0}
                expanded={isExpanded}
                onToggle={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [row.id]: !(prev[row.id] ?? true),
                  }))
                }
              />,
              ...(isExpanded
                ? children.map((child) => (
                    <ComponentTableRow
                      key={child.id}
                      row={child}
                      mode={mode}
                      nested
                    />
                  ))
                : []),
            ];
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function ComponentTableRow({
  row,
  mode,
  nested = false,
  hasChildren = false,
  expanded = false,
  onToggle,
}: {
  row: ComponentRow;
  mode: "rate" | "total";
  nested?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { id, c, manifest } = row;
  const tCount = throughputCounter(c, manifest);
  const tRate = throughputRate(c, manifest);
  const eCount = c.errors;
  const eRate = perComponentRate(c).errors;
  // Manifest label is the friendly name ("Worker · my-app"); fall
  // back to the raw component id so plumbing rows the manifest
  // doesn't cover still show up rather than going blank.
  const primary = manifest?.label ?? id;
  const detail = manifest?.detail ?? `${c.kind} · ${c.type}`;
  const errorsHasBreakdown =
    c.errorsByType && Object.keys(c.errorsByType).length > 0;
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={4} wrap="nowrap" pl={nested ? 22 : 0}>
          {hasChildren ? (
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={onToggle}
              aria-label={expanded ? "Collapse source breakdown" : "Expand source breakdown"}
            >
              {expanded ? (
                <IconChevronDown size={12} />
              ) : (
                <IconChevronRight size={12} />
              )}
            </ActionIcon>
          ) : !nested ? (
            <span style={{ width: 18, flex: "0 0 18px" }} />
          ) : null}
          <Tooltip label={id} withinPortal openDelay={400}>
            <Text size="xs" truncate>
              {primary}
            </Text>
          </Tooltip>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed" truncate>
          {detail}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="xs">
          {mode === "rate"
            ? tRate !== null
              ? `${fmt1(tRate)}/min`
              : "—"
            : tCount !== undefined
              ? fmtN(tCount)
              : "—"}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Tooltip
          label={errorsByTypeTooltip(c)}
          disabled={!errorsHasBreakdown}
          multiline
          w={280}
          withinPortal
        >
          <Text
            size="xs"
            c={(c.errors ?? 0) > 0 ? "red.5" : undefined}
            style={{
              textDecoration: errorsHasBreakdown ? "underline dotted" : undefined,
              cursor: errorsHasBreakdown ? "help" : undefined,
            }}
          >
            {mode === "rate"
              ? eRate !== null
                ? `${fmt1(eRate)}/min`
                : "—"
              : eCount !== undefined
                ? fmtN(eCount)
                : "—"}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="xs" c="dimmed">
          {relativeTime(c.lastSeen)}
        </Text>
      </Table.Td>
    </Table.Tr>
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
function parentSourceIds(manifestById: Map<string, ApiComponentManifestEntry>) {
  const ids = new Set<string>();
  for (const m of manifestById.values()) {
    if (m.role === "source" && m.links?.parentId) ids.add(m.links.parentId);
  }
  return ids;
}

function userTotals(
  snap: ApiMetricsSnapshot,
  manifestById: Map<string, ApiComponentManifestEntry>,
) {
  let received = 0;
  let sent = 0;
  let errors = 0;
  const sourceParents = parentSourceIds(manifestById);
  for (const [id, c] of Object.entries(snap.byComponent)) {
    if (isInternalComponent(id)) continue;
    const manifest = manifestById.get(id) ?? null;
    if (manifest?.role === "source") {
      if (!sourceParents.has(id)) {
        received += throughputCounter(c, manifest) ?? 0;
      }
    } else if (!manifest && c.kind === "source") {
      received += throughputCounter(c, manifest) ?? 0;
    }
    if (manifest?.role === "sink" || (!manifest && c.kind === "sink")) {
      sent += throughputCounter(c, manifest) ?? 0;
      errors += c.errors ?? 0;
    }
  }
  return { received, sent, errors };
}

function userLifetime(
  snap: ApiMetricsSnapshot,
  manifestById: Map<string, ApiComponentManifestEntry>,
) {
  // Lifetime offsets are tracked across all components, so we can't
  // cleanly split them by kind retroactively. For now, surface the
  // current-process totals as "since this Vector started" and use
  // the global lifetime_offset as an indicator that a restart
  // occurred — the UI can footnote "events from before the last
  // restart aren't kind-aggregated."
  return userTotals(snap, manifestById);
}

function userRates(
  snap: ApiMetricsSnapshot,
  manifestById: Map<string, ApiComponentManifestEntry>,
) {
  let received = 0;
  let sent = 0;
  let errors = 0;
  const sourceParents = parentSourceIds(manifestById);
  for (const [id, c] of Object.entries(snap.byComponent)) {
    if (isInternalComponent(id)) continue;
    const manifest = manifestById.get(id) ?? null;
    const r = perComponentRate(c);
    const sourceRate = throughputRate(c, manifest);
    if (manifest?.role === "source") {
      if (!sourceParents.has(id) && sourceRate !== null) {
        received += sourceRate;
      }
    } else if (!manifest && c.kind === "source" && sourceRate !== null) {
      received += sourceRate;
    }
    if (manifest?.role === "sink" || (!manifest && c.kind === "sink")) {
      const sinkRate = throughputRate(c, manifest);
      if (sinkRate !== null) sent += sinkRate;
      if (r.errors !== null) errors += r.errors;
    }
  }
  return { received, sent, errors };
}

function perComponentRate(c: ApiMetricsComponent) {
  return {
    received: rateFor(c,"received"),
    sent: rateFor(c,"sent"),
    errors: rateFor(c,"errors"),
    discarded: rateFor(c,"discarded"),
  };
}

function fmt1(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0";
  if (n < 0.1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function fmtN(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
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
  // All sources the user owns across every connection. The picker
  // groups them by connection; whatever's selected drives which
  // connections this deployment uses — there's no separate "join
  // connections to deployment" step.
  const [allUserSources, setAllUserSources] = useState<
    Array<{
      id: string;
      connectionId: string;
      sourceKind: string;
      displayName: string;
    }>
  >([]);
  const [allUserConnections, setAllUserConnections] = useState<
    Array<{
      id: string;
      displayName: string;
      provider: string;
      externalAccountId: string | null;
    }>
  >([]);
  const [monitors, setMonitors] = useState<ApiMonitor[]>([]);
  const [destinations, setDestinations] = useState<ApiDestination[]>([]);

  const [name, setName] = useState(deployment.displayName);
  // Always an explicit set. Legacy deployments with sourceIds=null
  // ("all from anchor connection") are expanded to the anchor's
  // current source ids on first mount — saving back writes the
  // explicit array, completing the one-way migration. New
  // deployments never have null in the first place.
  const [pickedSources, setPickedSources] = useState<Set<string>>(
    new Set(deployment.sourceIds ?? []),
  );
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const modernSources = !!deployment.graphSelection && !deployment.graphSelection.legacySources;
  const sourceBaseline = useMemo(() => new Set(
    modernSources
      ? deployment.graphSelection!.connections.flatMap(connection =>
          connection.selectAll || connection.discoverSources
            ? allUserSources.filter(source => source.connectionId === connection.id).map(source => source.id)
            : connection.sourceIds)
      : deployment.sourceIds ?? allUserSources.filter(source => source.connectionId === deployment.connectionId).map(source => source.id),
  ), [deployment, allUserSources, modernSources]);
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
    let active = true;
    setCatalogStatus("loading");
    Promise.all([api.listAllSources(), api.listMonitors(), api.listDestinations()])
      .then(([sources, monitors, destinations]) => {
        if (!active) return;
        setAllUserSources(sources.sources);
        setAllUserConnections(sources.connections);
        setMonitors(monitors.monitors);
        setDestinations(destinations.destinations);
        setCatalogStatus("ready");
      })
      .catch(() => { if (active) setCatalogStatus("failed"); });
    return () => { active = false; };
  }, [catalogRetry]);

  // When the deployment row reloads (e.g. after Save), rehydrate local
  // state to match.
  useEffect(() => {
    setName(deployment.displayName);
    setPickedSources(new Set(sourceBaseline));
    setAllMonitors(deployment.monitorIds === null);
    setPickedMonitors(new Set(deployment.monitorIds ?? []));
    setHeartbeatTarget(deployment.heartbeatTarget ?? "logtura");
    setMetricsTarget(deployment.metricsTarget ?? "none");
  }, [deployment, sourceBaseline]);

  // Retain modern graph connections while their discovery policy is unchanged,
  // including connections that currently have no sources. Explicit edits derive
  // connections from the selected source owners.
  const derivedConnectionIds = useMemo(() => {
    const ids = new Set<string>();
    if (modernSources && setsEqual(pickedSources, sourceBaseline)) {
      for (const connection of deployment.graphSelection!.connections) ids.add(connection.id);
    }
    for (const s of allUserSources) {
      if (pickedSources.has(s.id)) ids.add(s.connectionId);
    }
    return ids;
  }, [pickedSources, allUserSources, modernSources, sourceBaseline, deployment]);

  // Applicable monitors: user-scoped null (apply to all) OR
  // scoped to one of the derived connections.
  const applicableMonitors = useMemo(
    () =>
      monitors.filter(
        (m) =>
          m.connectionId === null || derivedConnectionIds.has(m.connectionId),
      ),
    [monitors, derivedConnectionIds],
  );

  const metricsDestinations = useMemo(
    () => destinations.filter((d) => d.flows.includes("metrics")),
    [destinations],
  );

  const dirty =
    name.trim() !== deployment.displayName ||
    // A legacy NULL we've expanded locally is always "dirty" so the
    // Save button is enabled — saving migrates the row to an
    // explicit array. Otherwise compare the picked set verbatim.
    (!modernSources && deployment.sourceIds === null) ||
    !setsEqual(pickedSources, sourceBaseline) ||
    allMonitors !== (deployment.monitorIds === null) ||
    !setsEqual(pickedMonitors, new Set(deployment.monitorIds ?? [])) ||
    heartbeatTarget !== (deployment.heartbeatTarget ?? "logtura") ||
    metricsTarget !== (deployment.metricsTarget ?? "none");

  async function save() {
    if (catalogStatus !== "ready" || saving || !dirty || !name.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await api.updateDeployment(deployment.id, {
        displayName: name.trim(),
        // Only edited modern sections switch to the website's flat selectors.
        // Preserve CLI discovery policies and monitor ordering on unrelated saves.
        ...(!modernSources || !setsEqual(pickedSources, sourceBaseline)
          ? { sourceIds: [...pickedSources] } : {}),
        ...(!deployment.graphSelection || deployment.graphSelection.legacyMonitors ||
          allMonitors !== (deployment.monitorIds === null) ||
          !setsEqual(pickedMonitors, new Set(deployment.monitorIds ?? []))
          ? { monitorIds: allMonitors ? null : [...pickedMonitors] } : {}),
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
      const next = new Set(allMonitors ? applicableMonitors.map(monitor => monitor.id) : prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  if (catalogStatus === "loading") {
    return <Group><Loader size="xs" aria-label="Loading deployment configuration" /><Text>Loading deployment configuration…</Text></Group>;
  }
  if (catalogStatus === "failed") {
    return <Alert color="red"><Stack gap="sm"><Text>Could not load configuration data. Retry before saving.</Text><Button onClick={() => setCatalogRetry(value => value + 1)}>Retry configuration data</Button></Stack></Alert>;
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
        </Stack>
      </Card>

      <Card withBorder p="lg">
        <Stack gap="md">
          <Stack gap={2}>
            <Text fw={600}>Sources</Text>
            <Text size="xs" c="dimmed">
              Pick what to forward. The deployment's connections are whichever
              connections own the selected sources — no separate join step.
            </Text>
            {deployment.graphSelection && !deployment.graphSelection.legacySources && deployment.graphSelection.connections.some(c=>c.selectAll || c.discoverSources) && (
              <Text size="sm">Current mode: {deploymentSourceSummary(deployment)}. Changing the source selections below switches to an explicit list when saved.</Text>
            )}
            {derivedConnectionIds.size > 0 && (
              <Group gap={4} mt={4}>
                <Text size="xs" c="dimmed">
                  Currently uses:
                </Text>
                {[...derivedConnectionIds].map((cid) => {
                  const c = allUserConnections.find((x) => x.id === cid);
                  if (!c) return null;
                  return (
                    <Badge key={cid} size="xs" variant="light">
                      {c.displayName} · {c.provider}
                    </Badge>
                  );
                })}
              </Group>
            )}
          </Stack>
          <SourcePickerByConnection
            connections={allUserConnections}
            sources={allUserSources}
            picked={pickedSources}
            toggle={toggleSource}
            setPicked={setPickedSources}
          />
        </Stack>
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
  initialDeployJob,
  onRefresh,
}: {
  deployment: ApiDeployment;
  bundle: ApiTargetBundle | null;
  initialDeployJob: ApiJob | null;
  onRefresh: () => void;
}) {
  return (
    <Stack gap="lg">
      <ManagedDeployCard
        deployment={deployment}
        initialDeployJob={initialDeployJob}
        onRefresh={onRefresh}
      />

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

/** Cross-connection source picker. Flat list grouped by connection
 *  with a filter input. No wildcard — `picked` is always the
 *  authoritative explicit set. Bulk actions: select-all-visible
 *  (respects the current filter) and clear-all. Per-group "toggle
 *  all in this connection" makes "I want every Fly app" a one-click
 *  affair without conflating connection-join with source-pick. */
function SourcePickerByConnection({
  connections,
  sources,
  picked,
  toggle,
  setPicked,
}: {
  connections: Array<{
    id: string;
    displayName: string;
    provider: string;
    externalAccountId: string | null;
  }>;
  sources: Array<{
    id: string;
    connectionId: string;
    sourceKind: string;
    displayName: string;
  }>;
  picked: Set<string>;
  toggle: (id: string, on: boolean) => void;
  setPicked: (next: Set<string>) => void;
}) {
  const [filter, setFilter] = useState("");

  const grouped = useMemo(() => {
    const filterLower = filter.trim().toLowerCase();
    const out: Array<{
      conn: (typeof connections)[number];
      items: typeof sources;
    }> = [];
    for (const conn of connections) {
      const items = sources.filter(
        (s) =>
          s.connectionId === conn.id &&
          (filterLower === "" ||
            s.displayName.toLowerCase().includes(filterLower) ||
            s.sourceKind.toLowerCase().includes(filterLower)),
      );
      if (items.length > 0) out.push({ conn, items });
    }
    return out;
  }, [connections, sources, filter]);

  const visibleIds = useMemo(
    () => grouped.flatMap((g) => g.items.map((s) => s.id)),
    [grouped],
  );
  const totalShown = visibleIds.length;
  const allVisibleSelected =
    totalShown > 0 && visibleIds.every((id) => picked.has(id));

  if (sources.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No sources discovered yet. Connect a provider on the Connections page.
      </Text>
    );
  }

  function selectAllVisible() {
    const next = new Set(picked);
    for (const id of visibleIds) next.add(id);
    setPicked(next);
  }
  function clearVisible() {
    const next = new Set(picked);
    for (const id of visibleIds) next.delete(id);
    setPicked(next);
  }
  function toggleGroup(items: typeof sources, on: boolean) {
    const next = new Set(picked);
    for (const s of items) {
      if (on) next.add(s.id);
      else next.delete(s.id);
    }
    setPicked(next);
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {picked.size === 0
            ? "Nothing selected — pick sources to forward."
            : `${picked.size} source${picked.size === 1 ? "" : "s"} selected`}
        </Text>
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={selectAllVisible}
            disabled={totalShown === 0 || allVisibleSelected}
          >
            Select all{filter ? " matching" : ""}
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={clearVisible}
            disabled={
              totalShown === 0 ||
              !visibleIds.some((id) => picked.has(id))
            }
          >
            Clear{filter ? " matching" : ""}
          </Button>
        </Group>
      </Group>
      <TextInput
        size="xs"
        aria-label="Filter sources"
        placeholder="Filter by name or kind…"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      <ScrollArea h={300}>
        <Stack gap="md">
          {grouped.map(({ conn, items }) => {
            const groupAllOn = items.every((s) => picked.has(s.id));
            return (
              <Stack key={conn.id} gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6}>
                    <Text fw={600} size="sm">
                      {conn.displayName}
                    </Text>
                    <Badge size="xs" variant="light">
                      {conn.provider}
                    </Badge>
                  </Group>
                  <Switch
                    size="xs"
                    label="All"
                    aria-label={`All sources from ${conn.displayName}`}
                    checked={groupAllOn}
                    onChange={(e) =>
                      toggleGroup(items, e.currentTarget.checked)
                    }
                  />
                </Group>
                <Stack gap={2} pl="md">
                  {items.map((s) => (
                    <Group key={s.id} justify="space-between">
                      <Stack gap={0}>
                        <Text size="sm">{s.displayName}</Text>
                        <Text size="xs" c="dimmed">
                          {s.sourceKind}
                        </Text>
                      </Stack>
                      <Switch
                        aria-label={s.displayName}
                        checked={picked.has(s.id)}
                        onChange={(e) => toggle(s.id, e.currentTarget.checked)}
                        size="sm"
                      />
                    </Group>
                  ))}
                </Stack>
              </Stack>
            );
          })}
          {totalShown === 0 && (
            <Text size="sm" c="dimmed">
              No sources match "{filter}".
            </Text>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

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

function ManagedDeployCard({
  deployment,
  initialDeployJob,
  onRefresh,
}: {
  deployment: ApiDeployment;
  initialDeployJob: ApiJob | null;
  onRefresh: () => void;
}) {
  const [targets, setTargets] = useState<ApiDeployTarget[] | null>(null);
  const [connecting, setConnecting] = useState<{
    sessionId: string;
    authUrl: string;
  } | null>(null);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Seed from the server-side active-job-by-lock-key lookup so a hard
  // reload mid-deploy reattaches to the running job instead of
  // forgetting it. Repo rule: UX-submitted jobs must rehydrate from
  // the server on page mount (see CLAUDE.md).
  const [deployJob, setDeployJob] = useState<ApiJob | null>(
    initialDeployJob,
  );
  const [deploying, setDeploying] = useState(false);
  const deployInFlightRef = useRef(false);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [lastRefreshedJobId, setLastRefreshedJobId] = useState<string | null>(
    null,
  );

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
    // If a deploy is already in flight (just rehydrated by the
    // server-side latestDeployJob lookup), don't fire another — the
    // dedup would no-op it anyway, but skipping avoids a confusing
    // POST in the network panel.
    if (
      deployJob &&
      (deployJob.status === "queued" || deployJob.status === "running")
    ) {
      setAutoTriggered(true);
      return;
    }
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
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await api.flyConnectPoll(connecting.sessionId);
        if (cancelled) return;
        if (r.status === "connected") {
          setConnecting(null);
          setPollMessage(`Connected as ${r.displayName}`);
          await refetch();
          return;
        }
        timer = setTimeout(tick, 2000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Polling failed");
        setConnecting(null);
      }
    };
    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connecting]);

  // Poll the deploy job until it terminates.
  useEffect(() => {
    if (!deployJob) return;
    if (deployJob.status === "succeeded" || deployJob.status === "failed") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await api.getJob(deployJob.id);
        if (cancelled) return;
        setDeployJob(r.job);
        if (r.job.status === "queued" || r.job.status === "running") {
          timer = setTimeout(tick, 2000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Job poll failed");
      }
    };
    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deployJob]);

  // Keep deployment header/banners in sync after a successful managed
  // deploy so "out of date" clears immediately without a hard reload.
  useEffect(() => {
    if (!deployJob || deployJob.status !== "succeeded") return;
    if (lastRefreshedJobId === deployJob.id) return;
    setLastRefreshedJobId(deployJob.id);
    void onRefresh();
  }, [deployJob, lastRefreshedJobId, onRefresh]);

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
    if (
      deployInFlightRef.current ||
      deploying ||
      deployJob?.status === "queued" ||
      deployJob?.status === "running"
    ) {
      return;
    }
    deployInFlightRef.current = true;
    setError(null);
    setDeploying(true);
    try {
      const r = await api.deployNow(deployment.id, { deployTargetId: targetId });
      setDeployJob(r.job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to start deploy");
    } finally {
      deployInFlightRef.current = false;
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
          {deployJob.status === "failed" ? (
            `Deploy failed: ${deployJob.error ?? "unknown"}`
          ) : (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                {deployJob.progress?.label ??
                  (deployJob.status === "queued"
                    ? "Queued"
                    : "Deploying…")}
              </Text>
              {deployJob.progress?.detail && (
                <Text size="xs" c="dimmed">
                  {deployJob.progress.detail}
                </Text>
              )}
            </Stack>
          )}
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
          disabled={
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
