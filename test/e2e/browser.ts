import assert from "node:assert/strict";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";

/** Real built React UI against the same workerd service used by the installed CLI. */
export async function startBrowser(service: { url: string; cookie: string }) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), ".tmp/playwright");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  let context: BrowserContext | undefined;
  let page: Page;
  function responseFor(predicate: Parameters<Page["waitForResponse"]>[0]) {
    const pending = page.waitForResponse(predicate);
    // A preceding UI action can fail first. Keep this rejection handled while
    // retaining it for the awaiting caller, so its resource cleanup still runs.
    void pending.catch(() => {});
    return pending;
  }
  async function signedIn() {
    if (context) await context.close();
    context = await browser.newContext();
    await context.route("https://fly.io/authorize/fixture-fly-session", route => route.fulfill({ contentType: "text/html", body: "Fixture Fly authorization" }));
    await context.addCookies([{ name: "logtura_session", value: service.cookie.slice("logtura_session=".length), url: service.url, httpOnly: true, sameSite: "Lax" }]);
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push(error.message));
    return page;
  }
  try {
    const anonymous = await browser.newContext();
    const visitor = await anonymous.newPage(); visitor.setDefaultTimeout(15_000);
    visitor.on("pageerror", error => errors.push(error.message));
    await visitor.goto(service.url + "/app/cli");
    await visitor.getByText("Sign in to authorize the CLI for your Logtura account.", { exact: true }).waitFor();
    assert.match(await visitor.getByRole("main").getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href") ?? "", /^\/login\/github\?return_to=/);
    await visitor.getByRole("banner").getByRole("link", { name: "logtura", exact: true }).waitFor();
    await visitor.getByRole("banner").getByRole("link", { name: "Sign in with GitHub", exact: true }).waitFor();
    await visitor.goto(service.url + "/docs/open-source");
    await visitor.getByRole("heading", { name: "Open source", exact: true }).waitFor();
    await visitor.getByRole("banner").getByRole("link", { name: "Docs", exact: true }).waitFor();
    await visitor.getByRole("banner").getByRole("link", { name: "Sign in with GitHub", exact: true }).waitFor();
    await anonymous.close();
    await signedIn();
    return {
      async createConnection(displayName: string, onCreated: (id: string) => void) {
        await page.goto(service.url + "/app/connections/new?provider=cloudflare-worker-tail");
        await page.getByRole("textbox", { name: "Provider", exact: true }).waitFor();
        await page.getByRole("textbox", { name: "Connection name", exact: true }).fill(displayName);
        await page.getByRole("button", { name: "Or create the token manually", exact: true }).click();
        await page.getByLabel(/^Paste the token Cloudflare gave you/).fill("fixture-private-provider-token");
        const created = responseFor(response => response.url() === service.url + "/api/connections" && response.request().method() === "POST");
        await page.getByRole("button", { name: "Verify & continue", exact: true }).click();
        const response = await created;
        assert.equal(response.status(), 200, "website connection creation must succeed");
        const body = await response.json();
        assert.equal(typeof body.connection?.id, "string");
        onCreated(body.connection.id);
        await page.waitForURL(`${service.url}/app/connections/${body.connection.id}`);
        await page.getByRole("heading", { name: displayName, exact: true }).waitFor();
        return body.connection.id as string;
      },
      async createDeployment(connectionId: string, onCreated: (id: string) => void, options: { managed?: boolean; name?: string } = {}) {
        await page.goto(`${service.url}/app/connections/${connectionId}/deploy?target=fly`);
        const name = options.name ?? "Existing fixture forwarder";
        await page.getByRole("textbox", { name: "Deployment name", exact: true }).fill(name);
        if (options.managed) await page.getByText("Let logtura manage it", { exact: true }).click();
        const created = responseFor(response => response.url() === service.url + "/api/deployments" && response.request().method() === "POST");
        await page.getByRole("button", { name: options.managed ? "Create deployment" : "Create & generate Fly.io bundle", exact: true }).click();
        const response = await created; assert.equal(response.status(), 200, "website deployment creation must succeed");
        const body = await response.json(); assert.equal(typeof body.deployment?.id, "string");
        assert.equal(body.deployment.connectionId, connectionId); assert.equal(body.deployment.targetKind, "fly"); assert.equal(body.deployment.managed, options.managed ?? false);
        onCreated(body.deployment.id);
        await page.waitForURL(`${service.url}/app/deployments/${body.deployment.id}${options.managed ? "?tab=run" : ""}`);
        await page.getByRole("heading", { name, exact: true }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name, exact: true }).waitFor();
        return body.deployment.id as string;
      },
      async connectAndDeployManaged(id: string, onTarget: (id: string) => void) {
        await page.goto(`${service.url}/app/deployments/${id}?tab=run`);
        const connected = responseFor(response => response.url().startsWith(`${service.url}/api/deploy-targets/fly/poll?`) && response.status() === 200);
        await page.getByRole("button", { name: "Connect Fly", exact: true }).click();
        const target = await (await connected).json(); assert.equal(target.status, "connected"); onTarget(target.deployTargetId);
        return this.redeployManaged(id, "Deploy now");
      },
      async redeployManaged(id: string, label = "Deploy now") {
        await page.goto(`${service.url}/app/deployments/${id}?tab=run`);
        const started = responseFor(response => response.url() === `${service.url}/api/deployments/${id}/deploy` && response.request().method() === "POST");
        await page.getByRole("button", { name: label, exact: true }).click();
        const response = await started; assert.equal(response.status(), 200); const body = await response.json();
        assert.equal(typeof body.job.id, "string");
        const rehydrated = responseFor(response => response.url() === `${service.url}/api/deployments/${id}` && response.request().method() === "GET");
        await page.reload(); const detail = await (await rehydrated).json();
        assert.equal(detail.latestDeployJob?.id, body.job.id, "reload must retain the actual managed parent job");
        return body.job.id as string;
      },
      async approve(code: string) {
        await page.goto(`${service.url}/app/cli?code=${encodeURIComponent(code)}`);
        await page.getByText(code, { exact: true }).waitFor();
        await page.getByRole("button", { name: "Approve CLI access", exact: true }).click();
        await page.getByText("Approved. Return to your terminal to finish signing in.", { exact: true }).waitFor();
      },
      async deny(code: string) {
        await page.goto(`${service.url}/app/cli?code=${encodeURIComponent(code)}`);
        await page.getByRole("button", { name: "Deny", exact: true }).click();
        await page.getByText("Access denied.", { exact: true }).waitFor();
      },
      async deployment(id: string, status: string) {
        await page.goto(`${service.url}/app/deployments/${id}`);
        const card = page.getByRole("region", { name: "Configuration revisions" });
        await card.getByText(status, { exact: true }).waitFor();
      },
      async changedConnection(id: string) {
        await page.goto(`${service.url}/app/connections/${id}`);
        await page.getByRole("heading", { name: "CLI-updated account", exact: true }).waitFor();
        const logout = responseFor(response => new URL(response.url()).pathname === "/logout");
        await page.getByRole("link", { name: "Sign out", exact: true }).click();
        assert.equal((await logout).status(), 303);
        assert.ok(!(await context!.cookies()).some(cookie => cookie.name === "logtura_session"), "sign-out must clear the browser session cookie");
        assert.deepEqual(errors, [], "sign-out must render without JavaScript errors");
        await page.getByRole("link", { name: "Sign up with GitHub", exact: true }).first().waitFor();
        await signedIn();
        await page.goto(`${service.url}/app/connections/${id}`);
        await page.getByRole("heading", { name: "CLI-updated account", exact: true }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name: "CLI-updated account", exact: true }).waitFor();
      },
      async rediscover(id: string, resume: () => void) {
        await page.goto(`${service.url}/app/connections/${id}`);
        const queued = responseFor(response => response.url() === `${service.url}/api/connections/${id}/discover` && response.request().method() === "POST");
        await page.getByRole("button", { name: "Re-discover", exact: true }).click();
        const response = await queued; assert.equal(response.status(), 200);
        const body = await response.json(); assert.equal(typeof body.job?.id, "string");
        const rehydrated = responseFor(response => response.url() === `${service.url}/api/connections/${id}` && response.request().method() === "GET");
        await page.reload();
        const resourceResponse = await rehydrated; assert.equal(resourceResponse.status(), 200);
        const resource = await resourceResponse.json();
        assert.equal(resource.latestDiscoveryJob?.id, body.job.id, "reload must return the same active discovery job");
        assert.ok(["queued", "running"].includes(resource.latestDiscoveryJob.status));
        const discovering = page.getByRole("button", { name: "Discovering…", exact: true });
        await discovering.waitFor(); assert.equal(await discovering.isDisabled(), true);
        await page.getByText("Discovery in progress…", { exact: true }).waitFor();
        resume();
        await page.getByRole("button", { name: "Re-discover", exact: true }).waitFor();
        await page.getByText("No sources discovered yet.", { exact: true }).waitFor();
        return body.job.id as string;
      },
      async reconnect(id: string, token: string) {
        await page.goto(`${service.url}/app/connections/${id}`);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Reconnect", exact: true });
        await dialog.getByRole("button", { name: "Or create the token manually", exact: true }).click();
        await dialog.getByLabel(/^Paste the token Cloudflare gave you/).fill(token);
        const reconnected = responseFor(response => response.url() === `${service.url}/api/connections/${id}/reconnect` && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
        const response = await reconnected; assert.equal(response.status(), 200, "website reconnection must succeed");
        const body = await response.json(); assert.equal(body.connection.id, id);
        await dialog.waitFor({ state: "hidden" }); await page.reload();
        await page.getByRole("heading", { name: "CLI-updated account", exact: true }).waitFor();
      },
      async enableMetrics(id: string, revisionStatus = "Configuration changed") {
        await page.goto(`${service.url}/app/deployments/${id}?tab=configure`);
        await page.getByRole("textbox", { name: "Metrics target", exact: true }).click();
        await page.getByRole("option", { name: "logtura (last-received only)", exact: true }).click();
        const saved = responseFor(response => response.url() === `${service.url}/api/deployments/${id}` && response.request().method() === "PUT");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        const response = await saved; assert.equal(response.status(), 200);
        const body = await response.json(); assert.equal(body.deployment.id, id); assert.equal(body.deployment.metricsTarget, "logtura");
        await page.getByRole("region", { name: "Configuration revisions" }).getByText(revisionStatus, { exact: true }).waitFor();
        await page.reload();
        await page.getByRole("textbox", { name: "Metrics target", exact: true }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Metrics target", exact: true }).inputValue(), "logtura (last-received only)");
        assert.equal(new URL(page.url()).searchParams.get("tab"), "configure");
      },
      async createMonitor(onCreated: (id: string) => void) {
        await page.goto(service.url + "/app/monitors");
        await page.getByRole("button", { name: "New monitor", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "New monitor", exact: true });
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Website alert");
        await dialog.getByRole("textbox", { name: "Scope", exact: true }).click();
        await page.getByRole("option", { name: "CLI-updated account", exact: true }).click();
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByRole("menuitem", { name: "Dedup", exact: true }).click();
        const filter = page.getByRole("dialog", { name: "Add Dedup", exact: true });
        await filter.getByRole("textbox", { name: "Window (seconds)", exact: true }).fill("120");
        // Type normally: the comma must survive each intermediate keystroke.
        const fields = filter.getByRole("textbox", { name: "Fields (comma-separated)", exact: true });
        await fields.fill(""); await fields.pressSequentially("script, message");
        await filter.getByRole("button", { name: "Add", exact: true }).click();
        await filter.waitFor({ state: "hidden" });
        const created = responseFor(response => response.url() === service.url + "/api/monitors" && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "Create", exact: true }).click();
        const response = await created;
        assert.equal(response.status(), 200, "website monitor creation must succeed");
        const body = await response.json(); assert.equal(typeof body.monitor?.id, "string");
        onCreated(body.monitor.id);
        await dialog.waitFor({ state: "hidden" });
        await page.reload();
        const card = page.getByRole("region", { name: "Monitor Website alert", exact: true });
        await card.getByText("CLI-updated account", { exact: true }).waitFor();
        await card.getByRole("button", { name: "Edit dedup 120s", exact: true }).click();
        const saved = page.getByRole("dialog", { name: "Edit Dedup", exact: true });
        assert.equal(await saved.getByRole("textbox", { name: "Fields (comma-separated)", exact: true }).inputValue(), "script, message");
        await saved.getByRole("button", { name: "Cancel", exact: true }).click();
        return body.monitor.id as string;
      },
      async cliUpdatedMonitor() {
        await page.goto(service.url + "/app/monitors");
        await page.reload();
        const card = page.getByRole("region", {name: "Monitor CLI-updated managed alert", exact: true});
        await card.getByRole("button", {name: "Edit dedup 45s", exact: true}).click();
        const dialog = page.getByRole("dialog", {name: "Edit Dedup", exact: true});
        assert.equal(await dialog.getByRole("textbox", {name: "Fields (comma-separated)", exact: true}).inputValue(), "message");
        await dialog.getByRole("button", {name: "Cancel", exact: true}).click();
      },
      async createDestination(url: string, onCreated: (id: string) => void) {
        await page.goto(service.url + "/app/destinations");
        await page.getByRole("button", { name: "Add HTTPS webhook destination", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Add HTTPS webhook destination", exact: true });
        await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Website routing");
        await dialog.getByRole("textbox", { name: "Webhook URL", exact: true }).fill(url);
        const created = responseFor(response => response.url() === service.url + "/api/destinations" && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "Add destination", exact: true }).click();
        const response = await created; assert.equal(response.status(), 200, "website destination creation must succeed");
        const body = await response.json(); assert.equal(typeof body.destination?.id, "string"); onCreated(body.destination.id);
        await dialog.waitFor({ state: "hidden" }); await page.reload();
        await page.getByRole("region", { name: "Destination Website routing", exact: true }).waitFor();
        return body.destination.id as string;
      },
      async addSink(monitorId: string) {
        await page.goto(service.url + "/app/monitors");
        const card = page.getByRole("region", { name: "Monitor Website alert", exact: true });
        await card.getByRole("button", { name: "Add sink", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Add sink to Website alert", exact: true });
        assert.equal(await dialog.getByRole("textbox", { name: "Destination", exact: true }).inputValue(), "Website routing (webhook)");
        const created = responseFor(response => response.url() === `${service.url}/api/monitors/${monitorId}/sinks` && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "Add sink", exact: true }).click();
        const response = await created; assert.equal(response.status(), 200, "website sink creation must succeed");
        const body = await response.json(); assert.equal(typeof body.sink?.id, "string");
        await dialog.waitFor({ state: "hidden" }); await page.reload();
        await card.getByText("→ Website routing", { exact: true }).waitFor();
        await card.getByRole("button", { name: "Edit dedup 300s", exact: true }).waitFor();
        return body.sink.id as string;
      },
      async applied(id: string, sequence: number, revision: string) {
        await this.deployment(id, "In sync");
        const card = page.getByRole("region", { name: "Configuration revisions" });
        await card.getByText(`Desired revision #${sequence} · ${revision.slice(7, 19)}`, { exact: true }).waitFor();
        await card.getByText(`Last applied revision #${sequence} · ${revision.slice(7, 19)}`, { exact: true }).waitFor();
        await page.reload();
        await card.getByText("In sync", { exact: true }).waitFor();
      },
      async metrics(id: string) {
        await page.goto(service.url + `/app/deployments/${id}`);
        const card = page.getByRole("region", { name: "Pipeline metrics" });
        await card.getByRole("button", { name: "Rate", exact: true }).waitFor();
        assert.equal(await card.getByText("0 /min", { exact: true }).count(), 3, "empty provider discovery must not count internal traffic as logs");
        await card.getByRole("button", { name: /^Show per-component/ }).click();
        await card.getByRole("checkbox", { name: "Show plumbing" }).check();
        const plumbing = card.getByRole("table", { name: "Internal plumbing metrics" });
        await plumbing.waitFor();
        assert.ok(await plumbing.getByRole("row").count() > 1, "real Vector must report internal components");
        await card.getByRole("button", { name: "Total", exact: true }).click();
        await card.getByText("Totals since the current Vector process started.", { exact: true }).waitFor();
        for (const label of ["Events received", "Events sent", "Errors"]) {
          await card.getByText(label, { exact: true }).locator("..").getByText("0", { exact: true }).waitFor();
        }
        await card.getByRole("button", { name: "Hide per-component", exact: true }).click();
        assert.equal(await card.getByRole("table").count(), 0);
        await page.reload();
        await card.getByRole("button", { name: "Rate", exact: true }).waitFor();
        assert.equal(await card.getByText("0 /min", { exact: true }).count(), 3);
      },
      async revoke() {
        await page.goto(service.url + "/app/cli");
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        await page.getByText("No active CLI clients.", { exact: true }).waitFor();
        await page.reload();
        await page.getByText("No active CLI clients.", { exact: true }).waitFor();
      },
      assertNoErrors() { assert.deepEqual(errors, [], "browser must have no unhandled JavaScript errors"); },
      async close() { await browser.close(); assert.deepEqual(errors, [], "browser must have no unhandled JavaScript errors through shutdown"); },
    };
  } catch (error) { await browser.close(); throw error; }
}
