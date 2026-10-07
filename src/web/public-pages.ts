export type PublicPageBlock =
  | { type: "paragraph"; text: string }
  | { type: "link"; href: string; label: string };

export interface PublicPageSection {
  heading?: string;
  blocks: PublicPageBlock[];
}

export interface PublicPageDefinition {
  title: string;
  description: string;
  sections: PublicPageSection[];
}

const issues = "https://github.com/logtura/logtura/issues";
const license = "https://github.com/logtura/logtura/blob/main/LICENSE";

export type PublicPageName = "privacy" | "terms" | "support";

export const publicPages: Record<PublicPageName, PublicPageDefinition> = {
  privacy: {
    title: "Logtura privacy policy",
    description: "How Logtura handles data across the website, hosted service, open-source software, and agent skill.",
    sections: [
      { blocks: [{ type: "paragraph", text: "This policy covers the Logtura website and hosted service, open-source CLI, libraries and forwarder, and Claude Code / Codex skill. Updated October 6, 2026." }] },
      { heading: "Open-source software and agent skill", blocks: [
        { type: "paragraph", text: "The skill is a package of instructions and reference files. It has no hosted backend, tracking code, or credential store. Your coding agent processes prompts, project files, and command output under its own provider's policies and permissions. Installing the skill does not create a Logtura account." },
        { type: "paragraph", text: "Standalone CLI configuration and credentials stay in the files and environment you choose. Commands that discover resources or deploy a forwarder contact the selected hosting providers. Your forwarder reads logs from your configured sources and sends them to your configured destinations; those providers receive the data needed for those operations. Standalone use does not require sending your configuration or logs to logtura.com." },
      ] },
      { heading: "Website and linked deployments", blocks: [
        { type: "paragraph", text: "GitHub sign-in supplies your GitHub identifier, login, profile name, avatar URL, and available email address. Logtura stores this account information, connection and destination settings, deployment manifests, authorization records, and deployment status and metrics to operate your account. Session cookies maintain sign-in; CLI access tokens authorize linked commands." },
        { type: "paragraph", text: "Provider and destination credentials submitted to the service are encrypted in storage and used to discover resources, generate configurations, and perform operations you request. Linking the CLI synchronizes configuration with the service. Configured heartbeats and metrics send deployment health and counters to the service. Log forwarding destinations are determined by your configuration, including any Logtura-related source or destination you explicitly select." },
        { type: "paragraph", text: "The website runs on Cloudflare. Provider integrations contact the providers you select. Deployment alert emails, when enabled, use Postmark and include your email address and deployment status. These services and your coding agent have their own privacy policies. Hosting infrastructure may process request metadata and operational diagnostics." },
      ] },
      { heading: "Retention and control", blocks: [
        { type: "paragraph", text: "Local configuration, generated bundles, and forwarder checkpoints remain under your control. You can remove website resources, revoke CLI access in the website, and revoke provider credentials at the provider. Removing configuration does not by itself stop a running forwarder or delete data already delivered to another service." },
        { type: "paragraph", text: "Account and deployment records are stored to support the service; this policy does not specify a fixed retention period for account records, operational diagnostics, or infrastructure backups. For account deletion or privacy questions, use the support page to request a private contact channel. Do not post credentials, logs, or personal information in a public issue." },
        { type: "link", href: "/support", label: "Privacy questions and support" },
      ] },
    ],
  },
  terms: {
    title: "Logtura terms of use",
    description: "Terms for the Logtura website, hosted service, open-source software, and agent skill.",
    sections: [
      { blocks: [{ type: "paragraph", text: "These terms apply to the Logtura website and hosted service, open-source CLI, libraries and forwarder, and Claude Code / Codex skill. Updated October 6, 2026." }] },
      { heading: "Open-source software", blocks: [
        { type: "paragraph", text: "The Logtura skill, CLI, and libraries are distributed under the Apache License 2.0. The license governs their use, modification, redistribution, and warranty limitations." },
        { type: "link", href: license, label: "Read the Apache 2.0 license" },
      ] },
      { heading: "Your projects and integrations", blocks: [
        { type: "paragraph", text: "Use credentials and resources you are authorized to manage. You choose the sources, filters, destinations, and deployment targets, and are responsible for permission to collect and forward their data. Hosting providers, log destinations, and coding agent services apply their own terms and charges." },
        { type: "paragraph", text: "The skill guides your coding agent; commands can create resources, change configuration, and incur provider costs. Review those actions through your agent's permission controls. Verify actual delivery after changes and maintain backups of configurations and credentials you need." },
      ] },
      { heading: "Optional hosted service", blocks: [
        { type: "paragraph", text: "A Logtura account is optional for standalone use. Website-linked commands use your account authorization to synchronize configuration and manage linked resources. Protect your account and tokens, and revoke access when it is no longer needed. Do not use the service to gain unauthorized access, interfere with other users, or forward data unlawfully." },
        { type: "paragraph", text: "The hosted service is provided without a published uptime or log-delivery guarantee. Keep recovery procedures for your forwarders and check their health. Removing a website record does not automatically terminate a forwarder running in your hosting account." },
        { type: "link", href: "/privacy", label: "How Logtura handles data" },
        { type: "link", href: "/support", label: "Questions about these terms" },
      ] },
    ],
  },
  support: {
    title: "Logtura support",
    description: "Support for the Logtura CLI, libraries, agent skill, hosted service, and linked forwarders.",
    sections: [{ blocks: [
      { type: "paragraph", text: "Get help with the Logtura CLI, libraries, Claude Code / Codex skill, and website-linked forwarders through the public project issue tracker." },
      { type: "link", href: issues, label: "Open or search a support issue" },
      { type: "paragraph", text: "Include your CLI version, host, command, and a redacted error or reproduction. For privacy, account deletion, or security concerns, request a private contact channel before sharing details. Never post tokens, provider credentials, raw logs, or personal information in a public issue. There is no published support response-time guarantee." },
      { type: "link", href: "/docs/agent-skills", label: "Skill installation and usage" },
      { type: "link", href: "/docs", label: "Logtura documentation" },
    ] }],
  },
};
