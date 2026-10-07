import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url).pathname;
const dist = join(root, "dist");
const shell = await readFile(join(dist, "index.html"), "utf8");
if (!shell.includes('<div id="root"></div>') || !shell.includes("<title>logtura</title>")) {
  throw new Error("dist/index.html is not the fresh Vite shell; run vite build before prerendering");
}
const { renderPath } = await import(pathToFileURL(join(root, ".tmp/prerender/entry-server.js")));

const routes = [
  { path: "/", title: "Logtura — Open-source log forwarding", description: "Discover logs across cloud providers and run an open-source forwarder in infrastructure you control.", expected: "Every log, from every provider" },
  { path: "/privacy", title: "Privacy policy | Logtura", description: "How Logtura handles data across its website, hosted service, open-source software, and agent skill.", expected: "Logtura privacy policy" },
  { path: "/terms", title: "Terms of use | Logtura", description: "Terms for the Logtura website, hosted service, open-source software, and agent skill.", expected: "Logtura terms of use" },
  { path: "/support", title: "Support | Logtura", description: "Support for the Logtura CLI, libraries, agent skill, hosted service, and linked forwarders.", expected: "Logtura support" },
  { path: "/docs", title: "Architecture | Logtura Docs", description: "How the Logtura control plane and open-source forwarder fit together.", expected: "Logtura has two parts" },
  { path: "/docs/overview", title: "Architecture | Logtura Docs", description: "How the Logtura control plane and open-source forwarder fit together.", expected: "Logtura has two parts" },
  { path: "/docs/hosted-ux", title: "Hosted UI | Logtura Docs", description: "Use Logtura connections, sources, destinations, and deployments.", expected: "The hosted UI" },
  { path: "/docs/deploy", title: "Deploy | Logtura Docs", description: "Build and run a Logtura forwarder on infrastructure you control.", expected: "Creating a deployment" },
  { path: "/docs/open-source", title: "Open source | Logtura Docs", description: "Use the Logtura CLI and libraries without a hosted-service account.", expected: "work without a Logtura account" },
  { path: "/docs/agent-skills", title: "Claude Code and Codex skill | Logtura Docs", description: "Install the Logtura skill and configure log forwarding with Claude Code or Codex.", expected: "Use Logtura with Claude Code or Codex" },
];

for (const route of routes) {
  const canonical = `https://logtura.com${route.path}`;
  const rendered = renderPath(route.path);
  if (!rendered.includes(route.expected)) throw new Error(`Prerendered ${route.path} is missing its expected content`);
  const metadata = [
    `<title>${escapeHtml(route.title)}</title>`,
    `<meta name="description" content="${escapeHtml(route.description)}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(route.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(route.description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:image" content="https://logtura.com/logo-512.png" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");
  const html = shell
    .replace("<title>logtura</title>", metadata)
    .replace('<div id="root"></div>', `<div id="root">${rendered}</div>`);
  const output = route.path === "/" ? join(dist, "index.html") : join(dist, `${route.path.slice(1)}.html`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
