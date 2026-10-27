import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-forgejo",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Forgejo",
  description: "Connect a Paperclip instance to a self-hosted Forgejo server",
  author: "Thomas Elliott",
  categories: ["connector"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["baseUrl", "token"],
    properties: {
      baseUrl: {
        type: "string",
        title: "Forgejo URL",
        description: "The address of your Forgejo server, for example https://git.example.com",
      },
      token: {
        // The secret picker stores { type: "secret_ref", secretId, version? }, not the token itself.
        type: "object",
        format: "secret-ref",
        title: "Access token",
        description: "A Forgejo access token, stored as a Paperclip secret",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "forgejo-connection",
        displayName: "Forgejo connection",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
