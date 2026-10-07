import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");

const prerendered = rootEl.dataset.prerenderedPath === window.location.pathname;
const app = (
  <StrictMode>
    <BrowserRouter>
      <App initialUser={prerendered ? null : undefined} />
    </BrowserRouter>
  </StrictMode>
);

if (prerendered) hydrateRoot(rootEl, app);
else createRoot(rootEl).render(app);
