import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconBrandAws,
  IconBrandGoogle,
  IconDroplet,
  IconRocket,
  IconServer2,
  IconWand,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { SelectionEditor } from "../components/SelectionEditor";
import type {
  ApiConnection,
  ApiDeployTargetDriver,
  ApiMonitor,
  ApiSource,
} from "../types";

type Step = "target" | "config";
const UNAVAILABLE_TARGET_MESSAGE = "This deployment target is unavailable. Choose another target.";

const TARGET_ICONS: Record<string, React.ReactNode> = {
  fly: <IconServer2 size={28} />,
  digitalocean: <IconDroplet size={28} />,
  aws: <IconBrandAws size={28} />,
  gcp: <IconBrandGoogle size={28} />,
  other: <IconWand size={28} />,
};

const DISABLED_TARGETS: { id: string; displayName: string; description: string }[] = [
  {
    id: "digitalocean",
    displayName: "DigitalOcean App Platform",
    description: "$5/month minimum container.",
  },
  {
    id: "aws",
    displayName: "AWS",
    description: "ECS / Fargate via CloudFormation.",
  },
  {
    id: "gcp",
    displayName: "Google Cloud Run",
    description: "Container as a service.",
  },
];

export function DeployWizard() {
  const { id: connectionId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const presetTarget = searchParams.get("target");
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(presetTarget ? "config" : "target");
  const [drivers, setDrivers] = useState<ApiDeployTargetDriver[]>([]);
  const [targetId, setTargetId] = useState<string | null>(presetTarget);

  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [monitors, setMonitors] = useState<ApiMonitor[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [allSourcesSelected, setAllSourcesSelected] = useState(true);
  const [pickedSourceIds, setPickedSourceIds] = useState<Set<string>>(new Set());
  const [allMonitorsSelected, setAllMonitorsSelected] = useState(true);
  const [pickedMonitorIds, setPickedMonitorIds] = useState<Set<string>>(new Set());
  const [managed, setManaged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .deployTargetDrivers()
      .then((r) => {
        setDrivers(r.drivers);
        if (presetTarget && !r.drivers.some(d => d.id === presetTarget)) {
          setTargetId(null);
          setStep("target");
          setError(UNAVAILABLE_TARGET_MESSAGE);
        }
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load targets"),
      );
    if (!connectionId) return;
    api
      .getConnection(connectionId)
      .then((r) => {
        setConnection(r.connection);
        setSources(r.sources);
        setName(`${r.connection.displayName}-forwarder`);
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load connection"),
      );
    api
      .listMonitors()
      .then((r) => setMonitors(r.monitors))
      .catch(() => {});
  }, [connectionId]);

  const driver = drivers.find((d) => d.id === targetId) ?? null;

  // Monitors applicable to this connection (scoped explicitly, or wildcard).
  const applicableMonitors = useMemo(
    () =>
      monitors.filter(
        (m) => m.connectionId === null || m.connectionId === connectionId,
      ),
    [monitors, connectionId],
  );

  const sinkCount = applicableMonitors.length; // proxy until we know sinks per monitor; safe lower bound
  const canDeploy =
    !!driver && !!connection && name.trim().length > 0 && (allSourcesSelected || pickedSourceIds.size > 0);

  function pickTarget(d: ApiDeployTargetDriver) {
    setError(previous => previous === UNAVAILABLE_TARGET_MESSAGE ? null : previous);
    setTargetId(d.id);
    if (!d.supportsManaged) setManaged(false);
    setStep("config");
  }

  function toggleSource(id: string, on: boolean) {
    setAllSourcesSelected(false);
    setPickedSourceIds((prev) => {
      const next = new Set(allSourcesSelected ? sources.map(source => source.id) : prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleMonitor(id: string, on: boolean) {
    setAllMonitorsSelected(false);
    setPickedMonitorIds((prev) => {
      const next = new Set(allMonitorsSelected ? applicableMonitors.map(monitor => monitor.id) : prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit() {
    if (!connectionId || !driver) return;
    setSubmitting(true);
    setError(null);
    try {
      const sourceIds = allSourcesSelected ? null : [...pickedSourceIds];
      const monitorIds = allMonitorsSelected ? null : [...pickedMonitorIds];
      const r = await api.createDeployment({
        connectionId,
        displayName: name.trim(),
        targetKind: driver.id,
        managed,
        sourceIds,
        monitorIds,
      });
      navigate(`/app/deployments/${r.deployment.id}${managed ? "?tab=run" : ""}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container size="lg">
      <Group justify="space-between" mb="md">
        <Stack gap={2}>
          <Title order={1}>New deployment</Title>
          <Text size="sm" c="dimmed">
            Pick a target and configure which sources and monitors run on it.
          </Text>
        </Stack>
        <Button
          component={Link}
          to={connectionId ? `/app/connections/${connectionId}` : "/app"}
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
        >
          Back
        </Button>
      </Group>

      <Stepper active={step === "target" ? 0 : 1} size="sm" mb="lg">
        <Stepper.Step label="Where" description="Pick a target" />
        <Stepper.Step label="Configure" description="Sources, monitors, deploy" />
      </Stepper>

      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}

      {step === "target" && (
        <TargetPicker drivers={drivers} onPick={pickTarget} />
      )}

      {step === "config" && driver && connection && (
        <Stack gap="md">
          <Group>
            <Button variant="subtle" size="sm" onClick={() => setStep("target")}>
              ← Switch target
            </Button>
            <Group gap={6}>
              <Badge variant="light">{driver.displayName}</Badge>
            </Group>
          </Group>

          <Card withBorder p="lg">
            <Stack gap="md">
              <TextInput
                label="Deployment name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                required
                description="Used as the Fly app name and the label in your dashboard."
              />

              {driver.supportsManaged && (
                <Stack gap="xs">
                  <Text size="sm" fw={600}>
                    How should we deploy this?
                  </Text>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <Card
                      withBorder
                      p="md"
                      style={{
                        cursor: "pointer",
                        borderColor: !managed
                          ? "var(--mantine-color-teal-5)"
                          : undefined,
                      }}
                      onClick={() => setManaged(false)}
                    >
                      <Group gap="xs" mb={4}>
                        <Switch checked={!managed} readOnly size="xs" />
                        <Text fw={600}>I'll handle it</Text>
                      </Group>
                      <Text c="dimmed" size="sm">
                        Get the {driver.displayName}-tailored bundle and run
                        it from your terminal. No credentials stored.
                      </Text>
                    </Card>
                    <Card
                      withBorder
                      p="md"
                      style={{
                        cursor: "pointer",
                        borderColor: managed
                          ? "var(--mantine-color-teal-5)"
                          : undefined,
                      }}
                      onClick={() => setManaged(true)}
                    >
                      <Group gap="xs" mb={4}>
                        <Switch checked={managed} readOnly size="xs" />
                        <Text fw={600}>Let logtura manage it</Text>
                      </Group>
                      <Text c="dimmed" size="sm">
                        We deploy it to your {driver.displayName} account
                        with credentials you provide. Revoke access anytime.
                      </Text>
                    </Card>
                  </SimpleGrid>
                </Stack>
              )}
            </Stack>
          </Card>

          <Card withBorder p="lg">
            <SelectionEditor
              label={`Sources (${sources.length} discovered)`}
              hint="All sources are forwarded by default."
              all={allSourcesSelected}
              onAll={(on) => {
                setAllSourcesSelected(on);
                if (on) setPickedSourceIds(new Set());
              }}
              items={sources.map((s) => ({
                id: s.id,
                label: s.displayName,
                sublabel: s.sourceKindLabel,
              }))}
              picked={pickedSourceIds}
              toggle={toggleSource}
            />
          </Card>

          <Card withBorder p="lg">
            <SelectionEditor
              label={`Monitors (${applicableMonitors.length} applicable)`}
              hint="All applicable monitors apply by default. New monitors auto-apply unless you customize."
              all={allMonitorsSelected}
              onAll={(on) => {
                setAllMonitorsSelected(on);
                if (on) setPickedMonitorIds(new Set());
              }}
              items={applicableMonitors.map((m) => ({
                id: m.id,
                label: m.displayName,
                sublabel:
                  m.filterSteps.length === 0
                    ? "no filters"
                    : `${m.filterSteps.length} step${m.filterSteps.length === 1 ? "" : "s"}`,
              }))}
              picked={pickedMonitorIds}
              toggle={toggleMonitor}
              empty={
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    You don't have any monitors yet — without one, this
                    deployment will run but won't ship logs anywhere.
                  </Text>
                  <Group>
                    <Button
                      component={Link}
                      to="/app/monitors"
                      size="xs"
                      variant="default"
                    >
                      Create a monitor
                    </Button>
                  </Group>
                </Stack>
              }
            />
          </Card>

          <Group justify="flex-end" mt="md">
            <Button
              variant="subtle"
              component={Link}
              to={`/app/connections/${connectionId}`}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!canDeploy}
            >
              {managed
                ? "Create deployment"
                : driver.id === "other"
                  ? "Create & show bundle"
                  : `Create & generate ${driver.displayName} bundle`}
            </Button>
          </Group>
        </Stack>
      )}
    </Container>
  );
}

function TargetPicker({
  drivers,
  onPick,
}: {
  drivers: ApiDeployTargetDriver[];
  onPick: (d: ApiDeployTargetDriver) => void;
}) {
  const named = drivers.filter((d) => d.id !== "other");
  const other = drivers.find((d) => d.id === "other");
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Where are you going to deploy this?
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        {named.map((d) => (
          <Card
            key={d.id}
            component="button"
            type="button"
            aria-label={`Deploy to ${d.displayName}`}
            withBorder
            p="lg"
            style={{ cursor: "pointer", textAlign: "left" }}
            onClick={() => onPick(d)}
          >
            <Group gap="sm" mb="xs">
              {TARGET_ICONS[d.id] ?? <IconRocket size={28} />}
              <Stack gap={0}>
                <Text fw={600}>{d.displayName}</Text>
                {d.supportsManaged && (
                  <Text size="xs" c="teal.4">
                    managed deploys available
                  </Text>
                )}
              </Stack>
            </Group>
            <Text size="sm" c="dimmed">
              {d.description}
            </Text>
          </Card>
        ))}
        {DISABLED_TARGETS.map((d) => (
          <Card
            component="button"
            type="button"
            aria-label={`Deploy to ${d.displayName}`}
            disabled
            key={d.id}
            withBorder
            p="lg"
            style={{ opacity: 0.55, cursor: "not-allowed" }}
          >
            <Group gap="sm" mb="xs">
              {TARGET_ICONS[d.id] ?? <IconRocket size={28} />}
              <Stack gap={0}>
                <Text fw={600}>{d.displayName}</Text>
                <Badge size="xs" variant="default">
                  on the way
                </Badge>
              </Stack>
            </Group>
            <Text size="sm" c="dimmed">
              {d.description}
            </Text>
          </Card>
        ))}
        {other && (
          <Card
            component="button"
            type="button"
            aria-label={`Deploy to ${other.displayName}`}
            withBorder
            p="lg"
            style={{ cursor: "pointer", textAlign: "left" }}
            onClick={() => onPick(other)}
          >
            <Group gap="sm" mb="xs">
              {TARGET_ICONS.other}
              <Text fw={600}>{other.displayName}</Text>
            </Group>
            <Text size="sm" c="dimmed">
              {other.description}
            </Text>
          </Card>
        )}
      </SimpleGrid>
    </Stack>
  );
}
