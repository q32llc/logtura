import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Stepper,
  Tabs,
  Text,
  TextInput,
  Title,
  Container,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconBrandAws,
  IconDroplet,
  IconBrandGoogle,
  IconCheck,
  IconCopy,
  IconRocket,
  IconServer2,
  IconWand,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import type { ApiDeployTargetDriver, ApiTargetBundle } from "../types";

type Step = "target" | "mode" | "bundle" | "managed";

interface TargetMeta {
  id: string;
  // override id-based icon if needed
  icon?: React.ReactNode;
}

const TARGET_ICONS: Record<string, React.ReactNode> = {
  fly: <IconServer2 size={28} />,
  digitalocean: <IconDroplet size={28} />,
  aws: <IconBrandAws size={28} />,
  gcp: <IconBrandGoogle size={28} />,
  other: <IconWand size={28} />,
};

// Disabled targets are shown but greyed out.
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
  const { id } = useParams<{ id: string }>();
  const [step, setStep] = useState<Step>("target");
  const [drivers, setDrivers] = useState<ApiDeployTargetDriver[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ApiTargetBundle | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .deployTargetDrivers()
      .then((r) => setDrivers(r.drivers))
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load targets"),
      );
  }, []);

  const driver = drivers.find((d) => d.id === targetId) ?? null;

  async function loadBundle(target: string) {
    if (!id) return;
    setLoadingBundle(true);
    setError(null);
    try {
      const b = await api.getTargetBundle(id, target);
      setBundle(b);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setLoadingBundle(false);
    }
  }

  async function pickTarget(d: ApiDeployTargetDriver) {
    setTargetId(d.id);
    if (d.id === "other") {
      // Other has no managed mode; jump straight to bundle.
      setStep("bundle");
      await loadBundle("other");
    } else if (d.supportsManaged) {
      setStep("mode");
    } else {
      setStep("bundle");
      await loadBundle(d.id);
    }
  }

  async function pickSelfDeploy() {
    if (!targetId) return;
    setStep("bundle");
    await loadBundle(targetId);
  }

  function pickManaged() {
    setStep("managed");
  }

  function reset() {
    setStep("target");
    setTargetId(null);
    setBundle(null);
  }

  const stepIndex = ["target", "mode", "bundle"].indexOf(step);

  return (
    <Container size="lg">
      <Group justify="space-between" mb="md">
        <Stack gap={2}>
          <Title order={1}>Deploy your forwarder</Title>
          <Text size="sm" c="dimmed">
            Pick where the Vector container will run. We tailor the bundle.
          </Text>
        </Stack>
        <Button
          component={Link}
          to={`/app/connections/${id}`}
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
        >
          Back to connection
        </Button>
      </Group>

      <Stepper active={Math.max(0, stepIndex)} size="sm" mb="lg">
        <Stepper.Step label="Where" description="Pick a target" />
        <Stepper.Step label="How" description="Self or managed" />
        <Stepper.Step label="Deploy" description="Bundle or run" />
      </Stepper>

      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}

      {step === "target" && (
        <TargetPicker drivers={drivers} onPick={pickTarget} />
      )}

      {step === "mode" && driver && (
        <ModePicker
          driver={driver}
          onSelfDeploy={pickSelfDeploy}
          onManaged={pickManaged}
          onBack={reset}
        />
      )}

      {step === "bundle" && (
        <BundlePanel
          loading={loadingBundle}
          bundle={bundle}
          onBack={reset}
        />
      )}

      {step === "managed" && driver && (
        <ManagedPanel driver={driver} onBack={() => setStep("mode")} />
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
  // Show available drivers first, then the disabled placeholders.
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
            withBorder
            p="lg"
            style={{ cursor: "pointer" }}
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
            withBorder
            p="lg"
            style={{ cursor: "pointer" }}
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

function ModePicker({
  driver,
  onSelfDeploy,
  onManaged,
  onBack,
}: {
  driver: ApiDeployTargetDriver;
  onSelfDeploy: () => void;
  onManaged: () => void;
  onBack: () => void;
}) {
  return (
    <Stack gap="md">
      <Group>
        <Button variant="subtle" size="sm" onClick={onBack}>
          ← Pick a different target
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        How do you want to deploy to {driver.displayName}?
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Card withBorder p="xl" style={{ cursor: "pointer" }} onClick={onSelfDeploy}>
          <Stack gap="sm">
            <Text fw={700} size="lg">
              I'll handle it
            </Text>
            <Text c="dimmed" size="sm">
              Get the {driver.displayName}-tailored config (Dockerfile,
              vector.yaml, fly.toml or equivalent, plus a launch script).
              Run it from your terminal. Total control, no credentials
              stored on our side.
            </Text>
            <Button mt="md" fullWidth>
              Give me the config
            </Button>
          </Stack>
        </Card>
        <Card
          withBorder
          p="xl"
          style={{ cursor: "pointer" }}
          onClick={onManaged}
        >
          <Stack gap="sm">
            <Group gap={6}>
              <Text fw={700} size="lg">
                Let logtura manage it
              </Text>
              <Badge size="xs" variant="light" color="teal">
                no lock-in
              </Badge>
            </Group>
            <Text c="dimmed" size="sm">
              We deploy and manage the forwarder on{" "}
              <strong>your {driver.displayName} account</strong>. Sources
              change, we redeploy. Crashes, we restart. Revoke our access
              anytime — the container keeps running on your cloud, no
              migration.
            </Text>
            <Button mt="md" fullWidth variant="filled" color="teal">
              Deploy with logtura
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

function BundlePanel({
  loading,
  bundle,
  onBack,
}: {
  loading: boolean;
  bundle: ApiTargetBundle | null;
  onBack: () => void;
}) {
  if (loading || !bundle) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }
  const tabs = [
    ...bundle.files.map((f) => ({ value: f.name, label: f.name, file: f })),
  ];
  const [first] = tabs;
  return (
    <Stack gap="md">
      <Group>
        <Button variant="subtle" size="sm" onClick={onBack}>
          ← Start over
        </Button>
        <Group gap={6}>
          <Badge variant="light">{bundle.target.displayName}</Badge>
          <Badge variant="default">self-deploy</Badge>
        </Group>
      </Group>

      <Card withBorder p="lg">
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Forwarding {bundle.selectedCount} source
            {bundle.selectedCount === 1 ? "" : "s"} · {bundle.monitorSummary}
          </Text>
          <Text size="sm">
            Save these files to an empty directory and follow the steps below.
          </Text>
        </Stack>
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

function ManagedPanel({
  driver,
  onBack,
}: {
  driver: ApiDeployTargetDriver;
  onBack: () => void;
}) {
  return (
    <Stack gap="md">
      <Group>
        <Button variant="subtle" size="sm" onClick={onBack}>
          ← Switch to self-deploy
        </Button>
      </Group>
      <Card withBorder p="xl">
        <Stack gap="sm">
          <Title order={3} size="h4">
            Managed {driver.displayName} deploy — coming next
          </Title>
          <Text c="dimmed">
            We're wiring this up. The driver and credential flow are in
            place; the actual deploy via {driver.displayName}'s API lands
            in the next iteration. For now, switch to self-deploy and run
            the bundle yourself — same files, same vector.yaml, same
            target-tailored config we'd use for the managed deploy.
          </Text>
          <Text size="sm" c="dimmed">
            When managed lands, your existing deployments keep running
            unchanged; you'll be able to opt in (or out) per deployment.
          </Text>
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
