import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

// Paperclip does not yet put plugin tools in an agent's tool list (paperclipai/paperclip#6707), so this
// skill tells agents to call them through Paperclip's API. Remove it once Paperclip delivers them.
export const TOOLS_SKILL_KEY = "forgejo-tools";

function parameterList(tool: PluginToolDeclaration): string {
  const schema = tool.parametersSchema as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties ?? {})
    .map((name) => (required.has(name) ? `\`${name}\` (required)` : `\`${name}\``))
    .join(", ");
}

export function toolsSkillMarkdown(pluginId: string, tools: PluginToolDeclaration[]): string {
  const toolList = tools.map((tool) => `- \`${tool.name}\`: ${tool.description} Parameters: ${parameterList(tool)}.`);
  return [
    "---",
    `name: ${JSON.stringify("Forgejo tools")}`,
    `description: ${JSON.stringify(
      "Use when a task involves Forgejo issues or pull requests: searching, reading, commenting on, creating or updating issues, and opening, reading, reviewing or merging pull requests.",
    )}`,
    "---",
    "",
    "# Forgejo tools",
    "",
    "The Forgejo plugin gives you tools for Forgejo issues and pull requests. Paperclip does not put",
    "these tools in your tool list yet, so call them through the Paperclip API.",
    "",
    "## Call a tool",
    "",
    "Your task must belong to a Paperclip project: Paperclip refuses tool calls without one.",
    "",
    "```bash",
    'API="${PAPERCLIP_API_URL%/}"; API="${API%/api}/api"',
    'AUTH="Authorization: Bearer $PAPERCLIP_API_KEY"',
    "# The project of your current task. Without jq, read projectId from the JSON another way.",
    'PROJECT_ID=$(curl -s -H "$AUTH" "$API/issues/$PAPERCLIP_TASK_ID" | jq -r .projectId)',
    "",
    'curl -s -X POST "$API/plugins/tools/execute" -H "$AUTH" \\',
    '  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" \\',
    "  -d '{",
    `    "tool": "${pluginId}:get_issue",`,
    '    "parameters": {"number": 12},',
    '    "runContext": {"agentId": "\'"$PAPERCLIP_AGENT_ID"\'", "runId": "\'"$PAPERCLIP_RUN_ID"\'",',
    '                   "companyId": "\'"$PAPERCLIP_COMPANY_ID"\'", "projectId": "\'"$PROJECT_ID"\'"}',
    "  }'",
    "```",
    "",
    "The answer is in `result.content`. A failed call still returns HTTP 200, with the reason in",
    "`result.error`: check it first, and report the error rather than working around it.",
    "",
    "## Tools",
    "",
    "Prefix each name with `" + pluginId + ":`. Most tools take `repository` as `owner/repo`; leave it out",
    "when the project uses exactly one Forgejo repository.",
    "",
    ...toolList,
    "",
    "## Review a pull request",
    "",
    "1. Read the diff with `get_pull_request_diff`. For a large pull request, list the files with",
    "   `list_pull_request_files` and read the diff one `path` at a time.",
    "2. Post one review with `review_pull_request`, passing the `commit` that the diff returned. Put",
    "   remarks about particular lines in `comments` rather than in the summary.",
    "3. To act on a review of your own pull request, read it with `list_reviews`.",
    "",
    "For the full parameter schemas:",
    "",
    "```bash",
    `curl -s -H "$AUTH" "$API/plugins/tools?pluginId=${pluginId}"`,
    "```",
    "",
  ].join("\n");
}
