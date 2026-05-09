import {
  Anchor,
  Button,
  Container,
  List,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router-dom";
import type { ApiUser } from "../types";

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state: "Sign-in failed: bad OAuth state. Please try again.",
  auth_required: "Please sign in to continue.",
};

export function Home({ user }: { user: ApiUser | null }) {
  const [params] = useSearchParams();
  const errorCode = params.get("error");
  const errorMsg = errorCode ? ERROR_MESSAGES[errorCode] : null;

  return (
    <Container size="sm" py={80}>
      <Stack gap="xl" align="center">
        <Stack gap="md" align="center">
          <Title order={1} ta="center" style={{ fontSize: 40 }}>
            Logs from 100 small sites, in one place.
          </Title>
          <Text size="lg" c="dimmed" ta="center" maw={520}>
            Connect your providers, discover every log source, deploy a
            zero-retention forwarder to the destination you already use.
            Built for indie operators and agencies — not the enterprise.
          </Text>
        </Stack>

        {errorMsg && (
          <Text c="red.4" size="sm">
            {errorMsg}
          </Text>
        )}

        {user ? (
          <Button component={Link} to="/app" size="lg">
            Go to dashboard
          </Button>
        ) : (
          <Button
            component="a"
            href="/login/github"
            size="lg"
            leftSection={<IconBrandGithub size={18} />}
          >
            Sign up with GitHub
          </Button>
        )}

        <Paper withBorder p="lg" radius="md" w="100%" mt="lg">
          <Title order={3} size="h4" mb="sm">
            What this does
          </Title>
          <List spacing="xs">
            <List.Item>
              Connect a Cloudflare account; we discover Workers and AI
              Gateways automatically.
            </List.Item>
            <List.Item>Pick which sources to forward — defaults to all.</List.Item>
            <List.Item>
              Download a Dockerfile that runs Vector and tails everything.
            </List.Item>
            <List.Item>
              Logs stream straight to your destination. Nothing is retained
              on our side.
            </List.Item>
          </List>
        </Paper>

        <Text size="xs" c="dimmed" mt="md">
          Open source forwarder.{" "}
          <Anchor
            href="https://github.com/"
            c="dimmed"
            underline="always"
          >
            Repository
          </Anchor>
          .
        </Text>
      </Stack>
    </Container>
  );
}
