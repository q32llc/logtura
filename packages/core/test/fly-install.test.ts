import { expect,it } from "vitest";
import { renderFlyToml } from "../src/fly-install";
it("renders the same always-on self-deploy settings with optional credential guidance", () => {
 const plain = renderFlyToml({appName: "logt-example", region: "iad"});
 expect(plain).toContain('app = "logt-example"'); expect(plain).toContain('primary_region = "iad"');
 expect(plain).toContain('  dockerfile = "Dockerfile"'); expect(plain).toContain("  memory_mb = 512");
 expect(plain).toContain("  auto_stop_machines = false"); expect(plain).toContain("  min_machines_running = 1");
 expect(plain).not.toContain("Required env-var secrets");
 const guided = renderFlyToml({appName: "logt-example", region: "ord", envVars: ["TOKEN", "DESTINATION_2"]});
 expect(guided).toContain("#   TOKEN\n#   DESTINATION_2");
 expect(renderFlyToml({appName: "app", region: "iad", envVars: []})).toContain("Required env-var secrets");
});
it.each(["", "name\nother", 'app"injection', "UPPER", "a".repeat(64), "../app"])("rejects unsafe app identity %j", appName => {
 expect(() => renderFlyToml({appName, region: "iad"})).toThrow("app name");
});
it.each(["", "IAD", "long", "iad\n"])("rejects invalid region %j", region => {
 expect(() => renderFlyToml({appName: "app", region})).toThrow("region");
});
it.each(["bad-name", "9TOKEN", "TOKEN\napp", ""])("rejects injected environment guidance %j", name => {
 expect(() => renderFlyToml({appName: "app", region: "iad", envVars: [name]})).toThrow("environment name");
});

it.each([undefined, null, 123])("rejects non-string identities from JavaScript callers: %j", value => {
 expect(() => renderFlyToml({appName: value as unknown as string, region: "iad"})).toThrow("app name");
 expect(() => renderFlyToml({appName: "app", region: value as unknown as string})).toThrow("region");
 expect(() => renderFlyToml({appName: "app", region: "iad", envVars: [value as unknown as string]})).toThrow("environment name");
});
