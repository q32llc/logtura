import {
  Alert,
  Button,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { ConnectSection, renderField } from "../components/ConnectSection";
import type { ApiProvider } from "../types";

export function NewConnection() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ApiProvider[] | null>(null);
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
          setProviderId(r.providers[0]!.id);
        }
      })
      .catch(() => setError("Failed to load providers"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const driver = providers?.find((p) => p.id === providerId) ?? null;
  const connect = driver?.connectFlow ?? null;
  const pasteFieldName =
    connect?.kind === "external_token" ? connect.pasteFieldName : null;

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

            {connect && driver && (
              <ConnectSection
                providerName={driver.displayName}
                flow={connect}
                clicked={connectClicked}
                onConnect={() => setConnectClicked(true)}
                showManual={showManual}
                toggleManual={() => setShowManual((v) => !v)}
                stepIndex={activeStep}
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

