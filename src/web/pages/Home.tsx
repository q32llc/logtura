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
            Connect your cloud accounts. We discover every Worker, function,
            app, and gateway that emits a log line — then ship a streaming
            forwarder you control. Nothing is retained on our side.
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
            body="Connect once. We enumerate every log source — Workers, edge functions, Lambdas, droplets, machines, AI gateways — and keep the list current as you ship."
          />
          <Feature
            icon={<IconLockOff size={22} />}
            title="Zero retention, by architecture"
            body="Logs stream through the collector to your destination. The control plane never receives a byte of log content. Not a policy — a property of the system."
          />
          <Feature
            icon={<IconRoute size={22} />}
            title="Send anywhere"
            body="Better Stack, Datadog, Axiom, Honeycomb, Grafana Loki, S3, or any HTTPS endpoint. Built on Vector, so your sink is whatever Vector supports."
          />
          <Feature
            icon={<IconSparkles size={22} />}
            title="Anomaly detection on the edge"
            body="Catch novel errors and unusual token distributions in real time, with bounded memory and zero retention. Backed by published research."
          />
          <Feature
            icon={<IconCurrencyDollarOff size={22} />}
            title="Per-source pricing"
            body="Pay for the sources you have, not the bytes you ship. The agency with 100 small sites stays on the free tier — that's the design, not a loophole."
          />
          <Feature
            icon={<IconPaperBag size={22} />}
            title="Open-source forwarder"
            body="The collector is Vector plus our open-source transforms. Self-host the whole thing, or run it through us. Leave anytime and keep the pipeline."
          />
        </SimpleGrid>
      </Container>

      {/* Built for ------------------------------------------------------ */}
      <Container size="md" py={64}>
        <Stack gap="lg" align="center">
          <Title order={2} ta="center">
            Built for the bottom of the market
          </Title>
          <Text c="dimmed" ta="center" maw={620}>
            Enterprise log pipelines charge by the byte and start at "let's
            get on a call." We charge per source, run on a free tier, and
            ship in five minutes. If you've ever lost an error to a
            forgotten provider, this is for you.
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
            No sales call. No per-byte pricing. No vendor lock-in.
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
              href="https://github.com/q32llc/logtura"
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
