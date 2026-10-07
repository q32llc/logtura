import { expect, it, vi } from "vitest";
import { api } from "./api";
import { renderPath } from "./entry-server";

it("renders complete public HTML without making a browser auth request", () => {
  const auth = vi.spyOn(api, "me");
  const html = renderPath("/privacy");
  expect(html).toContain("Logtura privacy policy");
  expect(html).toContain("Standalone use does not require sending your configuration or logs to logtura.com.");
  expect(auth).not.toHaveBeenCalled();
});
