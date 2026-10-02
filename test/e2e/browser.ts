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
  async function signedIn() {
    if (context) await context.close();
    context = await browser.newContext();
    await context.addCookies([{ name: "logtura_session", value: service.cookie.slice("logtura_session=".length), url: service.url, httpOnly: true, sameSite: "Lax" }]);
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push(error.message));
    return page;
  }
  try {
    const anonymous = await browser.newContext();
    const visitor = await anonymous.newPage(); visitor.setDefaultTimeout(15_000);
    await visitor.goto(service.url + "/app/cli");
    await visitor.getByText("Sign in to authorize the CLI for your Logtura account.", { exact: true }).waitFor();
    assert.match(await visitor.getByRole("main").getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href") ?? "", /^\/login\/github\?return_to=/);
    await anonymous.close();
    await signedIn();
    return {
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
        const logout = page.waitForResponse(response => new URL(response.url()).pathname === "/logout");
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
      async enableMetrics(id: string) {
        await page.goto(`${service.url}/app/deployments/${id}?tab=configure`);
        await page.getByRole("textbox", { name: "Metrics target", exact: true }).click();
        await page.getByRole("option", { name: "logtura (last-received only)", exact: true }).click();
        const saved = page.waitForResponse(response => response.url() === `${service.url}/api/deployments/${id}` && response.request().method() === "PUT");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        assert.equal((await saved).status(), 200);
        await page.getByRole("region", { name: "Configuration revisions" }).getByText("Configuration changed", { exact: true }).waitFor();
        await page.reload();
        await page.getByRole("textbox", { name: "Metrics target", exact: true }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Metrics target", exact: true }).inputValue(), "logtura (last-received only)");
        assert.equal(new URL(page.url()).searchParams.get("tab"), "configure");
      },
      async applied(id: string, sequence: number, revision: string) {
        await this.deployment(id, "In sync");
        const card = page.getByRole("region", { name: "Configuration revisions" });
        await card.getByText(`Desired revision #${sequence} · ${revision.slice(7, 19)}`, { exact: true }).waitFor();
        await card.getByText(`Last applied revision #${sequence} · ${revision.slice(7, 19)}`, { exact: true }).waitFor();
        await page.reload();
        await card.getByText("In sync", { exact: true }).waitFor();
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
