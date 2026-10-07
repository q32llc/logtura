import { beforeEach, expect, it, vi } from "vitest";

const reactDom = vi.hoisted(() => ({
  hydrateRoot: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  hydrateRoot: reactDom.hydrateRoot,
  createRoot: reactDom.createRoot,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  reactDom.createRoot.mockReturnValue({ render: reactDom.render });
  window.history.replaceState({}, "", "/");
});

it("hydrates HTML prerendered for the current path", async () => {
  document.body.innerHTML = '<div id="root" data-prerendered-path="/">server HTML</div>';
  await import("./main");
  expect(reactDom.hydrateRoot).toHaveBeenCalledOnce();
  expect(reactDom.createRoot).not.toHaveBeenCalled();
});

it("replaces a fallback document when it was prerendered for another path", async () => {
  document.body.innerHTML = '<div id="root" data-prerendered-path="/">fallback HTML</div>';
  window.history.replaceState({}, "", "/app");
  await import("./main");
  expect(reactDom.createRoot).toHaveBeenCalledWith(document.getElementById("root"));
  expect(reactDom.render).toHaveBeenCalledOnce();
  expect(reactDom.hydrateRoot).not.toHaveBeenCalled();
});

it("fails clearly when the application root is absent", async () => {
  document.body.innerHTML = "";
  await expect(import("./main")).rejects.toThrow("#root missing");
});
