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
const labels = { type: "array", items: { type: "string" }, description: "Label names, as shown in Forgejo." };
const assignees = { type: "array", items: { type: "string" }, description: "Forgejo user names." };

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
    description: "Opens a new issue in a Forgejo repository, optionally with labels and assignees.",
    parametersSchema: {
      type: "object",
      required: ["title"],
      properties: { repository, title: { type: "string" }, body: { type: "string", description: "Description in Markdown." }, labels, assignees },
    },
  },
  {
    name: "update_issue",
    displayName: "Update a Forgejo issue",
    description:
      "Changes the title, description, state, labels or assignees of a Forgejo issue or pull request. Set state to close or reopen one. Only the fields given change; labels and assignees replace the current ones, and an empty list removes them all.",
    parametersSchema: {
      type: "object",
      required: ["number"],
      properties: {
        repository,
        number,
        title: { type: "string" },
        body: { type: "string", description: "Description in Markdown." },
        state: { type: "string", enum: ["open", "closed"] },
        labels,
        assignees,
      },
    },
  },
  {
    name: "list_branches",
    displayName: "List Forgejo branches",
    description: "Lists a Forgejo repository's branches, each with its latest commit and whether it is protected.",
    parametersSchema: { type: "object", properties: { repository } },
  },
  {
    name: "read_file",
    displayName: "Read a file in Forgejo",
    description: "Reads a text file from a Forgejo repository at a branch, tag or commit. For a directory, lists what it contains.",
    parametersSchema: {
      type: "object",
      properties: {
        repository,
        path: { type: "string", description: "Path of the file or directory in the repository. Leave out to list the top folder." },
        ref: { type: "string", description: "Branch, tag or commit. Defaults to the repository's default branch." },
      },
    },
  },
  {
    name: "create_pull_request",
    displayName: "Open a Forgejo pull request",
    description:
      "Opens a pull request from a pushed branch and posts its link on your task. Push the branch first. For a branch in a fork, give head as forkowner:branch. linkedTask in the result is null when the link could not be posted; then add it to your task yourself.",
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
    name: "get_pull_request_diff",
    displayName: "Read a Forgejo pull request's diff",
    description:
      "Reads a pull request's changes as a unified diff, whole or for one file, and the commit it shows. Pass that commit to review_pull_request.",
    parametersSchema: {
      type: "object",
      required: ["number"],
      properties: { repository, number, path: { type: "string", description: "One changed file's path, to read only its part of the diff." } },
    },
  },
  {
    name: "review_pull_request",
    displayName: "Review a Forgejo pull request",
    description:
      "Posts a review of a pull request: a comment, a request for changes, or an approval, with optional comments on lines. Approving fails unless the operator has let agents approve in the plugin settings.",
    parametersSchema: {
      type: "object",
      required: ["number", "event", "commit"],
      properties: {
        repository,
        number,
        event: { type: "string", enum: ["comment", "request_changes", "approve"] },
        commit: { type: "string", description: "The commit you reviewed, as returned by get_pull_request_diff. Refused if the pull request has changed since." },
        body: { type: "string", description: "Review summary in Markdown. Required to request changes." },
        comments: {
          type: "array",
          description: "Comments on lines of the diff.",
          items: {
            type: "object",
            required: ["path", "line", "body"],
            properties: {
              path: { type: "string", description: "File path as shown in the diff." },
              line: { type: "integer", minimum: 1, description: "Line number in the file." },
              side: {
                type: "string",
                enum: ["new", "old"],
                default: "new",
                description: "new for a line in the changed file, old for a removed line, numbered in the file before the change.",
              },
              body: { type: "string", description: "Comment text in Markdown." },
            },
          },
        },
      },
    },
  },
  {
    name: "list_reviews",
    displayName: "List Forgejo pull request reviews",
    description: "Lists the reviews of a pull request, oldest first, each with its state, summary, comments on lines, and whether it counts under branch protection (official).",
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
    "issue.comments.create",
    "issues.wakeup",
    "agents.read",
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
      allowApprove: {
        type: "boolean",
        default: false,
        title: "Let agents approve pull requests",
        description: "Agents can always comment on a pull request or request changes. Forgejo branch protection decides whether an approval counts.",
      },
      privateNetwork: {
        type: "boolean",
        default: false,
        title: "Forgejo is on a private network",
        description:
          "Turn on if Paperclip reaches Forgejo at a private address, such as 192.168.x.x or 10.x.x.x. Paperclip blocks plugins from private addresses unless this is on.",
      },
      reviewToken: {
        type: "object",
        format: "secret-ref",
        title: "Reviewer access token",
        description:
          "Optional. A second Forgejo account's token, used only to post reviews. Forgejo does not let the account that opened a pull request approve it or request changes, so without this agents cannot do that on pull requests other agents opened.",
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
      description: "Receives Forgejo events, so synced issues update straight away and assignments, review requests and mentions wake agents",
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
