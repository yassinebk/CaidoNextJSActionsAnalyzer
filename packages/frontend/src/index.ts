import { Classic } from "@caido/primevue";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import { SDKPlugin } from "./plugins/sdk";
import "./styles/index.css";
import type { FrontendSDK } from "./types";
import App from "./views/App.vue";

export const init = (sdk: FrontendSDK) => {
  const app = createApp(App);

  // Load the PrimeVue component library
  app.use(PrimeVue, {
    unstyled: true,
    pt: Classic,
  });

  // Provide the FrontendSDK
  app.use(SDKPlugin, sdk);

  // Create the root element for the app
  const root = document.createElement("div");
  Object.assign(root.style, {
    height: "100%",
    width: "100%",
  });

  root.id = `plugin--nextjs-actions-analyzer`;

  // Mount the app to the root element
  app.mount(root);

  sdk.navigation.addPage("/nextjs-actions", {
    body: root,
  });

  sdk.sidebar.registerItem("Next.js Actions Analyzer", "/nextjs-actions");

  sdk.commands.register("nextjs-actions.scan", {
    name: "Next.js Actions Analyzer: Scan Proxy History",
    run: async () => {
      const result = await sdk.backend.scanProxyHistory();
      if (result.kind === "Error") {
        sdk.window.showToast(result.error, { variant: "error" });
        return;
      }
      sdk.window.showToast("Scan complete", { variant: "success" });
    },
    group: "Next.js Actions Analyzer",
  });

  sdk.commands.register("nextjs-actions.extract-names", {
    name: "Next.js Actions Analyzer: Extract Action Names",
    run: async () => {
      const result = await sdk.backend.extractActionNames();
      if (result.kind === "Error") {
        sdk.window.showToast(result.error, { variant: "error" });
        return;
      }
      sdk.window.showToast("Extraction complete", { variant: "success" });
    },
    group: "Next.js Actions Analyzer",
  });

  sdk.commands.register("nextjs-actions.find-unused", {
    name: "Next.js Actions Analyzer: Find Unused Actions",
    run: async () => {
      const result = await sdk.backend.findAllActions();
      if (result.kind === "Error") {
        sdk.window.showToast(result.error, { variant: "error" });
        return;
      }
      sdk.window.showToast("Discovery complete", { variant: "success" });
    },
    group: "Next.js Actions Analyzer",
  });

  sdk.commands.register("nextjs-actions.export", {
    name: "Next.js Actions Analyzer: Export Analysis",
    run: async () => {
      const result = await sdk.backend.exportAnalysis({
        includeExecuted: true,
        includeUnused: true,
        includeSecurity: true,
        includeFullDetails: false,
      });

      if (result.kind === "Error") {
        sdk.window.showToast(result.error, { variant: "error" });
        return;
      }

      const file = new File([result.value.json], result.value.filename, {
        type: "application/json",
      });
      await sdk.files.create(file);
      sdk.window.showToast("Export created in Files", { variant: "success" });
    },
    group: "Next.js Actions Analyzer",
  });

  sdk.commands.register("nextjs-actions.analyze-selection", {
    name: "Next.js Actions Analyzer: Analyze Selected Requests",
    run: async (ctx) => {
      if (ctx.type !== "RequestRowContext") {
        sdk.window.showToast("Select one or more requests first", {
          variant: "warning",
        });
        return;
      }

      const ids = ctx.requests.map((r) => r.id);
      const result = await sdk.backend.analyzeRequestsById(ids);
      if (result.kind === "Error") {
        sdk.window.showToast(result.error, { variant: "error" });
        return;
      }

      sdk.window.showToast(`Analyzed ${result.value.analyzed} requests`, {
        variant: "success",
      });
    },
    group: "Next.js Actions Analyzer",
  });

  sdk.menu.registerItem({
    type: "RequestRow",
    commandId: "nextjs-actions.analyze-selection",
    leadingIcon: "fas fa-magnifying-glass",
  });

  sdk.commandPalette.register("nextjs-actions.scan");
  sdk.commandPalette.register("nextjs-actions.extract-names");
  sdk.commandPalette.register("nextjs-actions.find-unused");
  sdk.commandPalette.register("nextjs-actions.export");
  sdk.commandPalette.register("nextjs-actions.analyze-selection");
};
