import {
  Alert,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconBolt, IconExternalLink } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { ConnectSection, renderField } from "../components/ConnectSection";
import type { ApiDeployTarget, ApiProvider } from "../types";

const OAUTH_ERROR_LABELS: Record<string, string> = {
  oauth_state:
    "Supabase OAuth state didn't match. Try connecting again from scratch.",
  supabase_oauth_not_configured:
    "Supabase OAuth isn't configured on this deployment. Paste a Personal Access Token instead.",
  supabase_oauth_exchange:
    "Supabase rejected the OAuth exchange. Try again, or paste a PAT.",
  supabase_oauth_verify:
    "Supabase OAuth succeeded but verifying the token failed. Try again.",
  supabase_oauth_no_projects:
    "The Supabase account you connected has no visible projects.",
  railway_oauth_state:
    "Railway OAuth state didn't match. Try connecting again from scratch.",
  railway_oauth_not_configured:
    "Railway OAuth isn't configured on this deployment. Paste a Railway token instead.",
  railway_oauth_exchange:
    "Railway rejected the OAuth exchange. Try again, or paste a token.",
  railway_oauth_verify:
    "Railway OAuth succeeded but verifying the token failed. Try again.",
  missing_display_name:
    "Pick a connection name before clicking Connect.",
  auth_required: "Sign in first, then try connecting again.",
};

function normalizeProviderParam(value: string | null): string | null {
  if (!value) return null;
  if (value === "vercel") return "vercel-logs";
  if (value === "railway") return "railway-logs";
  return value;
}

export function NewConnection() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get("error");
  const requestedProviderId = normalizeProviderParam(searchParams.get("provider"));
  const configurationId = searchParams.get("configurationId");
  const [providers, setProviders] = useState<ApiProvider[] | null>(null);
  const [deployTargets, setDeployTargets] = useState<ApiDeployTarget[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectClicked, setConnectClicked] = useState(false);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        if (r.providers.length > 0 && !providerId) {
          const requestedProvider = r.providers.find(
            (p) => p.id === requestedProviderId,
          );
          setProviderId(requestedProvider?.id ?? r.providers[0]!.id);
        }
      })
      .catch(() => setError("Failed to load providers"));
    // Deploy targets double as bootstraps — if the user already
    // connected Fly for a managed deploy, the same identity can mint
    // a scoped source credential without them leaving the dashboard.
    api
      .listDeployTargets()
      .then((r) => setDeployTargets(r.deployTargets))
      .catch(() => {
        // Non-fatal — paste flow still works.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!requestedProviderId || !configurationId) return;
    api
      .getConnectionByProviderInstallation(requestedProviderId, configurationId)
      .then((r) => {
        if (r.connection) {
          navigate(`/app/connections/${r.connection.id}`, { replace: true });
        }
      })
      .catch(() => {
        // Non-fatal — the page still works as a new connection flow.
      });
  }, [configurationId, navigate, requestedProviderId]);

  // A bootstrap is compatible with a source provider when the
  // bootstrap's driver declares it via `mintsForProviders`. Each
  // deploy_target row carries its driver's list via the API.
  const compatibleBootstraps = useMemo(
    () =>
      deployTargets.filter(
        (t) => providerId !== null && t.mintsForProviders.includes(providerId),
      ),
    [deployTargets, providerId],
  );

  const driver = providers?.find((p) => p.id === providerId) ?? null;
  const connect = driver?.connectFlow ?? null;
  const oauthShortcut = driver?.oauthShortcut ?? null;
  const pasteFieldName =
    connect?.kind === "external_token" ? connect.pasteFieldName : null;
  const oauthStartHref =
    oauthShortcut && displayName.trim()
      ? (() => {
          const params = new URLSearchParams({
            display_name: displayName,
          });
          if (configurationId) {
            params.set("configurationId", configurationId);
          }
          return `${oauthShortcut.startPath}?${params.toString()}`;
        })()
      : undefined;

  // Step state for the visual stepper.
  const pasteValue = pasteFieldName ? (fieldValues[pasteFieldName] ?? "") : "";
  const activeStep = !displayName.trim()
    ? 0
    : !connectClicked && connect
      ? 1
      : !pasteValue
        ? 2
        : 3;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!driver) return;
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("provider", driver.id);
      form.set("display_name", displayName);
      for (const f of driver.formFields) {
        form.set(f.name, fieldValues[f.name] ?? "");
      }
      const res = await api.createConnection(form);
      navigate(`/app/connections/${res.connection.id}`);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function mintFromBootstrap(bootstrap: ApiDeployTarget) {
    if (!driver) return;
    if (!displayName.trim()) {
      setError("Pick a connection name first");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.createConnectionFromBootstrap({
        deployTargetId: bootstrap.id,
        providerId: driver.id,
        displayName,
        scope: bootstrap.externalAccountId ?? undefined,
      });
      navigate(`/app/connections/${res.connection.id}`);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container size="sm">
      <Title order={1} mb="lg">
        Add connection
      </Title>

      <Paper withBorder p="lg">
        <form onSubmit={onSubmit}>
          <Stack gap="md">
            <Select
              label="Provider"
              data={
                providers?.map((p) => ({
                  value: p.id,
                  label: p.displayName,
                })) ?? []
              }
              value={providerId}
              onChange={setProviderId}
              required
              disabled={!providers}
            />

            <TextInput
              label="Connection name"
              placeholder={`My ${driver?.displayName ?? "Cloudflare"} account`}
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              required
            />

            {compatibleBootstraps.length > 0 && driver && (
              <Card withBorder p="md" radius="sm">
                <Stack gap="xs">
                  <Group gap={6}>
                    <IconBolt size={16} />
                    <Text fw={600} size="sm">
                      Use an existing {driver.displayName} connection
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    You already linked {driver.displayName} for a managed
                    deploy. We can mint a scoped source token from that
                    connection — no need to leave the dashboard.
                  </Text>
                  {compatibleBootstraps.map((b) => (
                    <Group key={b.id} justify="space-between" wrap="nowrap">
                      <Stack gap={0}>
                        <Text size="sm">{b.displayName}</Text>
                        {b.externalAccountId && (
                          <Text size="xs" c="dimmed">
                            org: {b.externalAccountId}
                          </Text>
                        )}
                      </Stack>
                      <Button
                        size="compact-sm"
                        variant="light"
                        loading={submitting}
                        disabled={!displayName.trim()}
                        onClick={() => mintFromBootstrap(b)}
                      >
                        Mint &amp; connect
                      </Button>
                    </Group>
                  ))}
                </Stack>
              </Card>
            )}
            {compatibleBootstraps.length > 0 && (
              <Divider
                label="Or paste a token yourself"
                labelPosition="center"
              />
            )}

            {oauthError && OAUTH_ERROR_LABELS[oauthError] && (
              <Alert color="red" variant="light">
                {OAUTH_ERROR_LABELS[oauthError]}
              </Alert>
            )}

            {oauthShortcut && driver && (
              <Card withBorder p="md" radius="sm">
                <Stack gap="xs">
                  <Text fw={600} size="sm">
                    {oauthShortcut.buttonLabel}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {oauthShortcut.buttonDescription}
                  </Text>
                  <Group>
                    <Button
                      component="a"
                      leftSection={<IconExternalLink size={16} />}
                      href={oauthStartHref}
                      disabled={!displayName.trim()}
                    >
                      {oauthShortcut.buttonLabel}
                    </Button>
                    {!displayName.trim() && (
                      <Text size="xs" c="dimmed">
                        Pick a connection name first.
                      </Text>
                    )}
                  </Group>
                </Stack>
              </Card>
            )}

            {oauthShortcut && (
              <Divider
                label="Or paste a Personal Access Token"
                labelPosition="center"
              />
            )}

            {connect && driver && (
              <ConnectSection
                providerName={driver.displayName}
                flow={connect}
                clicked={connectClicked}
                onConnect={() => setConnectClicked(true)}
                showManual={showManual}
                toggleManual={() => setShowManual((v) => !v)}
                stepIndex={activeStep}
                displayName={displayName}
              />
            )}

            {driver?.formFields
              .filter((f) => {
                // Hide the paste field until the user clicks Connect, so
                // the token paste step doesn't compete with the button
                // for attention. If there's no connectFlow, show all
                // fields up front.
                if (!connect) return true;
                if (
                  connect.kind === "external_token" &&
                  f.name === connect.pasteFieldName
                ) {
                  return connectClicked || showManual;
                }
                return connectClicked || showManual;
              })
              .map((f) => renderField(f, fieldValues, setFieldValues))}

            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}

            <Group justify="flex-end" mt="sm">
              <Button
                variant="subtle"
                component={Link}
                to="/app"
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" loading={submitting} disabled={!driver}>
                Verify &amp; continue
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>

      <Text size="xs" c="dimmed" mt="md">
        Credentials are AES-GCM encrypted at rest with a key the control
        plane never logs.
      </Text>
    </Container>
  );
}
