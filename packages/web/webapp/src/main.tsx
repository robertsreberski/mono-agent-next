// SPDX-License-Identifier: MIT
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { ConsoleProvider } from "./console";
import { WebRuntimeProvider } from "./runtime";
import "./styles.css";

registerSW({ immediate: true });

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <ConsoleProvider>
      <WebRuntimeProvider>
        <App />
      </WebRuntimeProvider>
    </ConsoleProvider>
  </StrictMode>,
);
