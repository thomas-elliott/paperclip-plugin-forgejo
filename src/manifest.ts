import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
// Paperclip shows the manifest version, so take it from package.json rather than keeping two copies.
import packageJson from "../package.json" with { type: "json" };

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-forgejo",
  apiVersion: 1,
  version: packageJson.version,
  displayName: "Forgejo",
  description: "Connect a Paperclip instance to a self-hosted Forgejo server",
  author: "Thomas Elliott",
  categories: ["connector"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "projects.read",
    "project.workspaces.read",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
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
      {
        type: "detailTab",
        id: "forgejo-project",
        displayName: "Forgejo",
        exportName: "ProjectRepositoryTab",
        entityTypes: ["project"],
      },
    ],
  },
};

export default manifest;
