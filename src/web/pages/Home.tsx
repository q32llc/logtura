import {
  Anchor,
  Badge,
  Box,
  Button,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconBrandCloudflare,
  IconBrandGithub,
  IconDroplet,
  IconBrandSupabase,
  IconBrandVercel,
  IconCloudUpload,
  IconCurrencyDollarOff,
  IconLockOff,
  IconPaperBag,
  IconQuote,
  IconRadar,
  IconRoute,
  IconServer2,
  IconSparkles,
} from "@tabler/icons-react";
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
    <Box>
      {/* Hero ----------------------------------------------------------- */}
      <Container size="md" pt={96} pb={64}>
        <Stack gap="xl" align="center">
          <Badge size="lg" variant="light" color="teal" radius="sm">
            Open source · Zero retention · Per-source pricing
          </Badge>
          <Title
            order={1}
            ta="center"
            style={{ fontSize: 56, lineHeight: 1.05, maxWidth: 760 }}
          >
            Every log, from every provider, in five minutes.
          </Title>
          <Text size="xl" c="dimmed" ta="center" maw={620}>
            Connect your cloud accounts. We find every Worker, function,
            app, and gateway that emits a log line, then ship you a
            streaming forwarder you run yourself. Nothing is retained on
            our side.
          </Text>

          {errorMsg && (
            <Text c="red.4" size="sm">
              {errorMsg}
            </Text>
          )}

          <Group gap="md">
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
            <Button
              component="a"
              href="#how"
              size="lg"
              variant="default"
            >
              How it works
            </Button>
          </Group>

          <Stack gap={2} align="center">
            <Text size="xs" c="dimmed" tt="uppercase" lts={2}>
              Discovers logs from
            </Text>
            <Group gap="lg" mt={4} c="dimmed">
              <ProviderTag icon={<IconBrandCloudflare size={20} />} label="Cloudflare" />
              <ProviderTag icon={<IconBrandSupabase size={20} />} label="Supabase" />
              <ProviderTag icon={<IconBrandVercel size={20} />} label="Vercel" />
              <ProviderTag icon={<IconDroplet size={20} />} label="DigitalOcean" />
              <ProviderTag icon={<IconServer2 size={20} />} label="Fly.io" />
              <ProviderTag icon={<IconCloudUpload size={20} />} label="AWS" />
            </Group>
          </Stack>
        </Stack>
      </Container>

      {/* Feature grid --------------------------------------------------- */}
      <Container size="lg" py={64} id="how">
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xl">
          <Feature
            icon={<IconRadar size={22} />}
            title="Discover everything"
            body="Connect once. We enumerate every log source you have: Workers, edge functions, Lambdas, droplets, machines, AI gateways. The list stays current as you ship."
          />
          <Feature
            icon={<IconLockOff size={22} />}
            title="Zero retention"
            body="Logs stream through the collector straight to your destination. The control plane never sees a byte of log content. The architecture makes it impossible."
          />
          <Feature
            icon={<IconRoute size={22} />}
            title="Send anywhere"
            body="Better Stack, Datadog, Axiom, Honeycomb, Grafana Loki, S3, any HTTPS endpoint. Built on Vector, so the sink list is whatever Vector supports."
          />
          <Feature
            icon={<IconSparkles size={22} />}
            title="Anomaly detection on the edge"
            body="Catch novel errors and unusual token distributions as they happen, in bounded memory, without retaining the logs. There's a research paper to back it up."
          />
          <Feature
            icon={<IconCurrencyDollarOff size={22} />}
            title="Per-source pricing"
            body="Pay per source. The free tier is sized for an agency running 100 small sites. They never have to upgrade."
          />
          <Feature
            icon={<IconPaperBag size={22} />}
            title="Open-source forwarder"
            body="The collector is Vector plus our open-source transforms. Self-host the whole thing, or run it through us. Leave anytime and the pipeline keeps running."
          />
        </SimpleGrid>
      </Container>

      {/* Testimonial ---------------------------------------------------- */}
      <Box
        py={72}
        style={(t) => ({
          borderTop: `1px solid ${t.colors.dark[6]}`,
          borderBottom: `1px solid ${t.colors.dark[6]}`,
          background: t.colors.dark[7],
        })}
      >
        <Container size="md">
          <Stack gap="lg" align="center">
            <ThemeIcon size={44} radius="md" variant="light" color="teal">
              <IconQuote size={24} />
            </ThemeIcon>
            <Text
              component="blockquote"
              m={0}
              ta="center"
              fw={650}
              style={{ fontSize: 30, lineHeight: 1.25, maxWidth: 820 }}
            >
              “Logtura saved my ass within hours of using it. Two dead sites
              revived. One lost customer recovered because I emailed them
              before they even knew there was a problem. I fixed bugs I
              couldn’t see before, and cut my Cloudflare bill in half after
              finding OOM issues and backed-up queues.”
            </Text>
            <Text c="dimmed" ta="center" size="sm">
              Early operator feedback
            </Text>
          </Stack>
        </Container>
      </Box>

      {/* Built for ------------------------------------------------------ */}
      <Container size="md" py={64}>
        <Stack gap="lg" align="center">
          <Title order={2} ta="center">
            Built for the bottom of the market
          </Title>
          <Text c="dimmed" ta="center" maw={620}>
            The forwarder is{" "}
            <Anchor href="https://github.com/logtura/logtura">
              open source
            </Anchor>
            , runs on your own infrastructure, and keeps working without us.
            The hosted control panel exists because setup and discovery are
            tedious, and the lazy path should still be the correct one.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" mt="md" w="100%">
            <Persona
              title="Agencies"
              body="30 customer sites across Cloudflare, Vercel, AWS, and a few VMs. One dashboard, one bill, no surprise GB charges."
            />
            <Persona
              title="Indie hackers"
              body="5–20 micro-SaaS apps, each with its own log mess. Connect them all in an afternoon."
            />
            <Persona
              title="AI builders"
              body="50+ rapid prototypes on Supabase Edge Functions, Fly machines, and Cloudflare Workers. We catch the rare error that breaks them."
            />
            <Persona
              title="Studios maintaining inherited stacks"
              body="10 customer projects, 8 different vendors. Get them all monitored without becoming an observability engineer."
            />
          </SimpleGrid>
        </Stack>
      </Container>

      {/* Final CTA ------------------------------------------------------ */}
      <Container size="sm" py={80}>
        <Stack gap="md" align="center">
          <Title order={2} ta="center">
            Five minutes from sign-in to logs.
          </Title>
          <Text c="dimmed" ta="center">
            Sign in with GitHub, paste an API token, copy a Dockerfile.
          </Text>
          {user ? (
            <Button component={Link} to="/app" size="lg" mt="md">
              Open dashboard
            </Button>
          ) : (
            <Button
              component="a"
              href="/login/github"
              size="lg"
              mt="md"
              leftSection={<IconBrandGithub size={18} />}
            >
              Sign up with GitHub
            </Button>
          )}
        </Stack>
      </Container>

      {/* Footer --------------------------------------------------------- */}
      <Container size="lg" py="lg">
        <Group justify="space-between" c="dimmed">
          <Text size="xs">logtura · open-source log forwarder control plane</Text>
          <Group gap="md">
            <Anchor
              size="xs"
              c="dimmed"
              href="https://github.com/logtura/logtura"
            >
              GitHub
            </Anchor>
          </Group>
        </Group>
      </Container>
    </Box>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Stack gap="xs">
      <ThemeIcon size={40} radius="md" variant="light" color="teal">
        {icon}
      </ThemeIcon>
      <Title order={3} size="h4">
        {title}
      </Title>
      <Text c="dimmed" size="sm">
        {body}
      </Text>
    </Stack>
  );
}

function Persona({ title, body }: { title: string; body: string }) {
  return (
    <Stack
      gap={4}
      p="md"
      style={(t) => ({
        border: `1px solid ${t.colors.dark[5]}`,
        borderRadius: t.radius.md,
        background: t.colors.dark[7],
      })}
    >
      <Text fw={600}>{title}</Text>
      <Text size="sm" c="dimmed">
        {body}
      </Text>
    </Stack>
  );
}

function ProviderTag({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Group gap={6} c="dimmed">
      {icon}
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}
