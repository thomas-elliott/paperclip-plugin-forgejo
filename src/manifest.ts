import type { PaperclipPluginManifestV1, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
// Paperclip shows the manifest version, so take it from package.json rather than keeping two copies.
import packageJson from "../package.json" with { type: "json" };
import { TOOLS_SKILL_KEY, toolsSkillMarkdown } from "./agent-skill.js";

// Installed settings and state are keyed on this ID, so it must never change.
const PLUGIN_ID = "paperclip-plugin-forgejo";

// Most tools take the repository as "owner/repo", optional when the project uses exactly one Forgejo repository.
const repository = {
  type: "string",
  description:
    "Forgejo repository as owner/repo. Leave out when the current Paperclip project uses exactly one Forgejo repository.",
};
const number = { type: "integer", minimum: 1, description: "Issue or pull request number." };

const tools: PluginToolDeclaration[] = [
  {
    name: "search_issues",
    displayName: "Search Forgejo issues and pull requests",
    description: "Lists issues or pull requests in a Forgejo repository, optionally filtered by a keyword and state.",
    parametersSchema: {
      type: "object",
      properties: {
        repository,
        query: { type: "string", description: "Keyword to search for in titles and descriptions." },
        type: { type: "string", enum: ["issues", "pulls"], default: "issues" },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: "get_issue",
    displayName: "Read a Forgejo issue",
    description: "Reads one Forgejo issue or pull request: title, description, state, labels and assignees.",
    parametersSchema: { type: "object", required: ["number"], properties: { repository, number } },
  },
  {
    name: "list_comments",
    displayName: "List Forgejo comments",
    description: "Lists the comments on a Forgejo issue or pull request, oldest first.",
    parametersSchema: { type: "object", required: ["number"], properties: { repository, number } },
  },
  {
    name: "add_comment",
    displayName: "Comment on Forgejo",
    description: "Adds a Markdown comment to a Forgejo issue or pull request.",
    parametersSchema: {
      type: "object",
      required: ["number", "body"],
      properties: { repository, number, body: { type: "string", description: "Comment text in Markdown." } },
    },
  },
  {
    name: "create_issue",
    displayName: "Create a Forgejo issue",
    description: "Opens a new issue in a Forgejo repository.",
    parametersSchema: {
      type: "object",
      required: ["title"],
      properties: { repository, title: { type: "string" }, body: { type: "string", description: "Description in Markdown." } },
    },
  },
  {
    name: "update_issue",
    displayName: "Update a Forgejo issue",
    description: "Changes the title, description or state of a Forgejo issue or pull request. Only the fields given change.",
    parametersSchema: {
      type: "object",
      required: ["number"],
      properties: {
        repository,
        number,
        title: { type: "string" },
        body: { type: "string", description: "Description in Markdown." },
        state: { type: "string", enum: ["open", "closed"] },
      },
    },
  },
  {
    name: "create_pull_request",
    displayName: "Open a Forgejo pull request",
    description:
      "Opens a pull request from a pushed branch. Push the branch first. For a branch in a fork, give head as forkowner:branch.",
    parametersSchema: {
      type: "object",
      required: ["head", "title"],
      properties: {
        repository,
        head: { type: "string", description: "Branch with the changes, or forkowner:branch." },
        base: { type: "string", description: "Branch to merge into. Defaults to the repository's default branch." },
        title: { type: "string" },
        body: { type: "string", description: "Description in Markdown." },
      },
    },
  },
  {
    name: "get_pull_request",
    displayName: "Read a Forgejo pull request",
    description: "Reads a Forgejo pull request: state, branches, whether it is merged or mergeable, and its description.",
    parametersSchema: { type: "object", required: ["number"], properties: { repository, number } },
  },
  {
    name: "list_pull_request_files",
    displayName: "List files in a Forgejo pull request",
    description: "Lists the files a Forgejo pull request changes, with lines added and removed.",
    parametersSchema: { type: "object", required: ["number"], properties: { repository, number } },
  },
  {
    name: "get_pull_request_checks",
    displayName: "Read Forgejo pull request checks",
    description: "Reads the combined CI status of a pull request's latest commit, and each check's result.",
    parametersSchema: { type: "object", required: ["number"], properties: { repository, number } },
  },
  {
    name: "merge_pull_request",
    displayName: "Merge a Forgejo pull request",
    description: "Merges a Forgejo pull request. Fails unless the operator has let agents merge in the plugin settings.",
    parametersSchema: {
      type: "object",
      required: ["number"],
      properties: { repository, number, method: { type: "string", enum: ["merge", "rebase", "squash"], default: "merge" } },
    },
  },
];
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
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
    "issues.read",
    "issues.create",
    "issues.update",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "webhooks.receive",
    "agent.tools.register",
    "skills.managed",
    "external.objects.detect",
    "external.objects.read",
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
      syncIssues: {
        type: "boolean",
        default: false,
        title: "Import Forgejo issues",
        description:
          "Import the open issues of each project's Forgejo repositories into the project, and keep their status in step",
      },
      allowMerge: {
        type: "boolean",
        default: false,
        title: "Let agents merge pull requests",
        description: "Forgejo branch protection still applies",
      },
      webhookSecret: {
        type: "object",
        format: "secret-ref",
        title: "Webhook secret",
        description: "The secret set on the Forgejo webhook, stored as a Paperclip secret. Optional: without a webhook, issues sync every five minutes.",
      },
    },
  },
  jobs: [
    {
      jobKey: "sync-issues",
      displayName: "Sync Forgejo issues",
      description: "Imports open Forgejo issues and keeps their status in step, for companies that turned on issue import",
      schedule: "*/5 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: "forgejo",
      displayName: "Forgejo events",
      description: "Receives issue events from a Forgejo webhook so synced issues update straight away",
    },
  ],
  objectReferences: [
    {
      providerKey: "forgejo",
      displayName: "Forgejo",
      objectTypes: ["issue", "pull_request"],
      urlPatterns: ["<Forgejo URL>/:owner/:repo/issues/:number", "<Forgejo URL>/:owner/:repo/pulls/:number"],
      refreshPolicy: { defaultTtlSeconds: 300 },
    },
  ],
  tools,
  skills: [
    {
      skillKey: TOOLS_SKILL_KEY,
      displayName: "Forgejo tools",
      markdown: toolsSkillMarkdown(PLUGIN_ID, tools),
    },
  ],
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
