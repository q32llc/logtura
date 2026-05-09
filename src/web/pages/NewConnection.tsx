import {
  Alert,
  Button,
  Container,
  Group,
  PasswordInput,
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
import type { ApiProvider } from "../types";

export function NewConnection() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ApiProvider[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
                providers?.map((p) => ({ value: p.id, label: p.displayName })) ??
                []
              }
              value={providerId}
              onChange={setProviderId}
              required
              disabled={!providers}
            />

            <TextInput
              label="Connection name"
              placeholder="My Cloudflare account"
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              required
            />

            {driver?.formFields.map((f) => {
              const props = {
                key: f.name,
                label: f.label,
                placeholder: f.placeholder,
                description: f.description,
                required: f.required,
                value: fieldValues[f.name] ?? "",
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  setFieldValues((s) => ({
                    ...s,
                    [f.name]: e.currentTarget.value,
                  })),
              };
              return f.type === "password" ? (
                <PasswordInput {...props} autoComplete="off" />
              ) : (
                <TextInput {...props} autoComplete="off" />
              );
            })}

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
                Connect &amp; discover
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
