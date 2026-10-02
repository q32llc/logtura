import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
export default defineConfig({
  plugins:[mdx({providerImportSource:"@mdx-js/react",remarkPlugins:[remarkGfm]}),react()],
  test:{name:"ui",environment:"jsdom",include:["src/web/**/*.test.tsx"],setupFiles:["test/ui/setup.ts"],
    coverage:{provider:"istanbul",reportsDirectory:"coverage/ui",reporter:["text","lcov","json-summary"],
      include:["src/web/**/*.{ts,tsx}"],exclude:["**/*.test.*","**/*.d.ts"],
      // First UI baseline: report the entire UI, including currently untested
      // pages. Final aggregate targets remain 90/90/90/85 in the rollout plan.
      thresholds:{statements:89.5,branches:89.5,functions:86,lines:90.5,"src/web/App.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/Home.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/Docs.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/DeploymentDetail.tsx":{statements:88,branches:85,functions:89,lines:90},"src/web/components/ConnectSection.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/ConnectionDetail.tsx":{statements:87,branches:83,functions:84,lines:88},"src/web/pages/DeployWizard.tsx":{statements:98,branches:95,functions:100,lines:100},"src/web/pages/Destinations.tsx":{statements:98,branches:97,functions:100,lines:100},"src/web/pages/Monitors.tsx":{statements:99,branches:95,functions:100,lines:100},"src/web/pages/Dashboard.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/NewConnection.tsx":{statements:95,branches:94,functions:100,lines:97},"src/web/components/SelectionEditor.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/components/FilterStepsEditor.tsx":{statements:98,branches:95,functions:100,lines:100},"src/web/components/DeploymentRevisionStatus.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/deployment-selection.ts":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/Deployments.tsx":{statements:100,branches:100,functions:100,lines:100},"src/web/pages/CliAccess.tsx":{statements:90,lines:90,functions:90,branches:85}},
    },
  },
});
