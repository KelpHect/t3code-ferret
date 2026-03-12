import { ClerkProvider, SignedIn, SignedOut, SignIn } from "@clerk/clerk-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { loadRuntimePublicConfig, RuntimeConfigProvider } from "./runtimeConfig";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

document.title = APP_DISPLAY_NAME;

async function bootstrap() {
  const runtimeConfig = await loadRuntimePublicConfig();
  const router = getRouter(history);
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  const app = (
    <React.StrictMode>
      <RuntimeConfigProvider value={runtimeConfig}>
        <RouterProvider router={router} />
      </RuntimeConfigProvider>
    </React.StrictMode>
  );

  if (
    runtimeConfig.deploymentMode !== "self-hosted" ||
    runtimeConfig.authProvider?.kind !== "clerk"
  ) {
    root.render(app);
    return;
  }

  root.render(
    <React.StrictMode>
      <RuntimeConfigProvider value={runtimeConfig}>
        <ClerkProvider publishableKey={runtimeConfig.authProvider.publishableKey}>
          <SignedIn>
            <RouterProvider router={router} />
          </SignedIn>
          <SignedOut>
            <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
              <div className="w-full max-w-sm rounded-2xl border border-border/70 bg-card/90 p-5 shadow-xl shadow-black/15">
                <SignIn />
              </div>
            </div>
          </SignedOut>
        </ClerkProvider>
      </RuntimeConfigProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
