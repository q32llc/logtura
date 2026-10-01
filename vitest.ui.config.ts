import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins:[react()],
  test:{name:"ui",environment:"jsdom",include:["src/web/**/*.test.tsx"],setupFiles:["test/ui/setup.ts"],
    coverage:{provider:"istanbul",reportsDirectory:"coverage/ui",reporter:["text","lcov","json-summary"],
      include:["src/web/**/*.{ts,tsx}"],exclude:["**/*.test.*","**/*.d.ts"],
      // First UI baseline: report the entire UI, including currently untested
      // pages. Final aggregate targets remain 90/90/90/85 in the rollout plan.
      thresholds:{statements:3,branches:2,functions:3,lines:2,"src/web/pages/CliAccess.tsx":{statements:90,lines:90,functions:90,branches:85}},
    },
  },
});
