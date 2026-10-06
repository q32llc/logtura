import { Anchor, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";

const issues = "https://github.com/logtura/logtura/issues";
const license = "https://github.com/logtura/logtura/blob/main/LICENSE";

export function Privacy() {
  return <PublicPage title="Privacy policy">
    <Text>Logtura publishes the open-source CLI, libraries, and Claude Code / Codex skill, and operates logtura.com. Updated October 6, 2026.</Text>
    <Title order={2}>Skill and standalone CLI</Title>
    <Text>The skill is a package of instructions and reference files. It has no hosted backend, tracking code, or credential store. Your coding agent processes prompts, project files, and command output under its own provider's policies and permissions. Installing the skill does not create a Logtura account.</Text>
    <Text>Standalone CLI configuration and credentials stay in the files and environment you choose. Commands that discover resources or deploy a forwarder contact the selected hosting providers. Your forwarder reads logs from your configured sources and sends them to your configured destinations; those providers receive the data needed for those operations. Standalone use does not require sending your configuration or logs to logtura.com.</Text>
    <Title order={2}>Website and linked deployments</Title>
    <Text>GitHub sign-in supplies your GitHub identifier, login, profile name, avatar URL, and available email address. Logtura stores this account information, connection and destination settings, deployment manifests, authorization records, and deployment status and metrics to operate your account. Session cookies maintain sign-in; CLI access tokens authorize linked commands.</Text>
    <Text>Provider and destination credentials submitted to the service are encrypted in storage and used to discover resources, generate configurations, and perform operations you request. Linking the CLI synchronizes configuration with the service. Configured heartbeats and metrics send deployment health and counters to the service. Log forwarding destinations are determined by your configuration, including any Logtura-related source or destination you explicitly select.</Text>
    <Text>The website runs on Cloudflare. Provider integrations contact the providers you select. Deployment alert emails, when enabled, use Postmark and include your email address and deployment status. These services and your coding agent have their own privacy policies. Hosting infrastructure may process request metadata and operational diagnostics.</Text>
    <Title order={2}>Retention and control</Title>
    <Text>Local configuration, generated bundles, and forwarder checkpoints remain under your control. You can remove website resources, revoke CLI access in the website, and revoke provider credentials at the provider. Removing configuration does not by itself stop a running forwarder or delete data already delivered to another service.</Text>
    <Text>Account and deployment records are stored to support the service; this policy does not specify a fixed retention period for account records, operational diagnostics, or infrastructure backups. For account deletion or privacy questions, use the support page to request a private contact channel. Do not post credentials, logs, or personal information in a public issue.</Text>
    <Anchor component={Link} to="/support">Privacy questions and support</Anchor>
  </PublicPage>;
}

export function Terms() {
  return <PublicPage title="Terms of use">
    <Text>These terms describe use of the Logtura skill and CLI and the optional logtura.com service. Updated October 6, 2026.</Text>
    <Title order={2}>Open-source software</Title>
    <Text>The Logtura skill, CLI, and libraries are distributed under the Apache License 2.0. The license governs their use, modification, redistribution, and warranty limitations.</Text>
    <Anchor href={license}>Read the Apache 2.0 license</Anchor>
    <Title order={2}>Your projects and integrations</Title>
    <Text>Use credentials and resources you are authorized to manage. You choose the sources, filters, destinations, and deployment targets, and are responsible for permission to collect and forward their data. Hosting providers, log destinations, and coding agent services apply their own terms and charges.</Text>
    <Text>The skill guides your coding agent; commands can create resources, change configuration, and incur provider costs. Review those actions through your agent's permission controls. Verify actual delivery after changes and maintain backups of configurations and credentials you need.</Text>
    <Title order={2}>Optional hosted service</Title>
    <Text>A Logtura account is optional for standalone use. Website-linked commands use your account authorization to synchronize configuration and manage linked resources. Protect your account and tokens, and revoke access when it is no longer needed. Do not use the service to gain unauthorized access, interfere with other users, or forward data unlawfully.</Text>
    <Text>The hosted service is provided without a published uptime or log-delivery guarantee. Keep recovery procedures for your forwarders and check their health. Removing a website record does not automatically terminate a forwarder running in your hosting account.</Text>
    <Anchor component={Link} to="/privacy">How Logtura handles data</Anchor>
    <Anchor component={Link} to="/support">Questions about these terms</Anchor>
  </PublicPage>;
}

export function Support() {
  return <PublicPage title="Logtura support">
    <Text>Get help with the Logtura CLI, libraries, Claude Code / Codex skill, and website-linked forwarders through the public project issue tracker.</Text>
    <Anchor href={issues}>Open or search a support issue</Anchor>
    <Text>Include your CLI version, host, command, and a redacted error or reproduction. For privacy, account deletion, or security concerns, request a private contact channel before sharing details. Never post tokens, provider credentials, raw logs, or personal information in a public issue. There is no published support response-time guarantee.</Text>
    <Anchor component={Link} to="/docs/agent-skills">Skill installation and usage</Anchor>
    <Anchor component={Link} to="/docs">Logtura documentation</Anchor>
  </PublicPage>;
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
