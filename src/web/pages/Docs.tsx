import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Container,
  Divider,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { MDXProvider } from "@mdx-js/react";
import { IconBrandGithub } from "@tabler/icons-react";
import type React from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import Deploy from "../docs/deploy.mdx";
import HostedUx from "../docs/hosted-ux.mdx";
import OpenSource from "../docs/open-source.mdx";
import Overview from "../docs/overview.mdx";
import Privacy from "../docs/privacy.mdx";

const DOCS = [
  {
    slug: "overview",
    title: "Overview",
    description: "The runtime boundary and control-plane model.",
    Component: Overview,
  },
  {
    slug: "hosted-ux",
    title: "Hosted UX",
    description: "How to use connections, destinations, and deployments.",
    Component: HostedUx,
  },
  {
    slug: "deploy",
    title: "Deploy",
    description: "What deploy does, and where the forwarder runs.",
    Component: Deploy,
  },
  {
    slug: "privacy",
    title: "Privacy model",
    description: "What Logtura sees, and what it avoids by design.",
    Component: Privacy,
  },
  {
    slug: "open-source",
    title: "Open source",
    description: "How to use Logtura without the hosted service.",
    Component: OpenSource,
  },
] as const;

export function Docs() {
  const { slug = "overview" } = useParams();
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return <Navigate to="/docs" replace />;

  const DocComponent = doc.Component;

  return (
    <Container size="xl" py={48}>
      <Stack gap={36}>
        <Stack gap="md">
          <Badge size="lg" variant="light" color="teal" radius="sm">
            Public docs
          </Badge>
          <Group justify="space-between" align="flex-end" gap="lg">
            <Box>
              <Title order={1} style={{ fontSize: 48, lineHeight: 1.05 }}>
                Logtura Docs
              </Title>
              <Text size="lg" c="dimmed" maw={760} mt="sm">
                How the hosted control panel, open-source forwarder, and
                deployment model fit together.
              </Text>
            </Box>
            <Button
              component="a"
              href="https://github.com/logtura/logtura"
              variant="default"
              leftSection={<IconBrandGithub size={18} />}
            >
              GitHub
            </Button>
          </Group>
        </Stack>

        <Group align="flex-start" gap={40} wrap="nowrap">
          <Stack
            gap="xs"
            w={260}
            pos="sticky"
            top={80}
            visibleFrom="md"
          >
            {DOCS.map((item) => (
              <NavLink
                key={item.slug}
                component={Link}
                to={`/docs/${item.slug}`}
                label={item.title}
                description={item.description}
                active={item.slug === doc.slug}
                variant="filled"
              />
            ))}
          </Stack>

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Stack gap="xs" hiddenFrom="md" mb="lg">
              {DOCS.map((item) => (
                <NavLink
                  key={item.slug}
                  component={Link}
                  to={`/docs/${item.slug}`}
                  label={item.title}
                  active={item.slug === doc.slug}
                  variant="filled"
                />
              ))}
            </Stack>

            <Box
              maw={820}
              style={(t) => ({
                "--docs-link": t.colors.teal[4],
                "--docs-heading": t.white,
                "--docs-body": t.colors.dark[1],
                "--docs-muted": t.colors.dark[2],
              })}
            >
              <MDXProvider components={mdxComponents}>
                <DocComponent />
              </MDXProvider>
            </Box>
          </Box>
        </Group>
      </Stack>
    </Container>
  );
}

const mdxComponents = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Title order={1} mb="lg" style={{ fontSize: 42, lineHeight: 1.08 }} {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <>
      <Divider mt={40} mb={30} />
      <Title order={2} mb="md" {...props} />
    </>
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Title order={3} size="h4" mt="lg" mb={6} {...props} />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <Text c="dimmed" size="md" mb="md" style={{ lineHeight: 1.7 }} {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <Box component="ul" c="dimmed" mb="md" pl="xl" style={{ lineHeight: 1.75 }} {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <Box component="ol" c="dimmed" mb="md" pl="xl" style={{ lineHeight: 1.75 }} {...props} />
  ),
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => (
    <Box component="li" mb={6} {...props} />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <Anchor {...props} />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => <Code {...props} />,
};
