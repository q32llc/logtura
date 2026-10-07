import { Anchor, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { publicPages, type PublicPageName } from "../public-pages";

export function Privacy() {
  return <PolicyPage name="privacy" />;
}

export function Terms() {
  return <PolicyPage name="terms" />;
}

export function Support() {
  return <PolicyPage name="support" />;
}

function PolicyPage({ name }: { name: PublicPageName }) {
  const page = publicPages[name];
  return <PublicPage title={page.title}>{page.sections.map((section, sectionIndex) => <Stack gap="lg" key={section.heading ?? sectionIndex}>
    {section.heading ? <Title order={2}>{section.heading}</Title> : null}
    {section.blocks.map((block, blockIndex) => block.type === "paragraph"
      ? <Text key={blockIndex}>{block.text}</Text>
      : block.href.startsWith("/")
        ? <Anchor component={Link} to={block.href} key={blockIndex}>{block.label}</Anchor>
        : <Anchor href={block.href} key={blockIndex}>{block.label}</Anchor>)}
  </Stack>)}</PublicPage>;
}

function PublicPage({ title, children }: { title: string; children: React.ReactNode }) {
  return <Container size="sm" py={48}><Stack gap="lg">
    <Title order={1}>{title}</Title>
    {children}
    <Group gap="lg">
      <Anchor component={Link} to="/">Logtura</Anchor>
      <Anchor component={Link} to="/privacy">Privacy</Anchor>
      <Anchor component={Link} to="/terms">Terms</Anchor>
      <Anchor component={Link} to="/support">Support</Anchor>
    </Group>
  </Stack></Container>;
}
