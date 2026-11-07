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

// Agents never hold the plugin's token: this script bundles the branch's new commits and passes them
// to the push_branch tool, which pushes them. String.raw keeps the shell and jq text as agents see it;
// the script avoids "${" for that reason.
function pushScript(pluginId: string): string {
  return String.raw`cat > "$HOME/forgejo-push" <<'EOF'
#!/bin/sh
# Pushes a branch to Forgejo through the Forgejo plugin. Needs curl, jq and base64.
# Usage: forgejo-push <branch> [owner/repo]
set -e
branch=$1
repository=$2
if [ -z "$branch" ]; then echo "Usage: forgejo-push <branch> [owner/repo]" >&2; exit 2; fi
api=$(printf '%s' "$PAPERCLIP_API_URL" | sed 's#/*$##; s#/api$##')/api
auth="Authorization: Bearer $PAPERCLIP_API_KEY"
project=$(curl -s -H "$auth" "$api/issues/$PAPERCLIP_TASK_ID" | jq -r .projectId)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Calls a plugin tool with the parameters in $work/parameters.json. Prints its data, or its error and fails.
call() {
  jq -n --arg tool "${pluginId}:$1" --slurpfile parameters "$work/parameters.json" \
    --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" --arg project "$project" \
    '{tool: $tool, parameters: $parameters[0],
      runContext: {agentId: $agent, runId: $run, companyId: $company, projectId: $project}}' > "$work/body.json"
  curl -s -X POST "$api/plugins/tools/execute" -H "$auth" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
    -H "Content-Type: application/json" --data-binary "@$work/body.json" > "$work/response.json"
  error=$(jq -r '.result.error // .error // empty' "$work/response.json")
  if [ -n "$error" ]; then echo "$error" >&2; return 1; fi
  jq .result.data "$work/response.json"
}

# Leave out every commit Forgejo already has, so the bundle holds only new ones.
jq -n --arg repository "$repository" 'if $repository == "" then {} else {repository: $repository} end' > "$work/parameters.json"
exclude=""
for commit in $(call list_branches | jq -r '.[].commit'); do
  if git cat-file -e "$commit^{commit}" 2>/dev/null; then exclude="$exclude ^$commit"; fi
done
git bundle create -q "$work/push.bundle" "refs/heads/$branch" $exclude

# Paperclip accepts requests up to 10 MB, and base64 makes the bundle a third larger.
size=$(wc -c < "$work/push.bundle")
if [ "$size" -gt 7000000 ]; then
  echo "The new commits on $branch take $size bytes; the plugin can push at most 7000000. Ask a person to push." >&2
  exit 1
fi
base64 < "$work/push.bundle" | tr -d '\n' > "$work/bundle.b64"
jq -n --arg repository "$repository" --arg branch "$branch" --rawfile bundle "$work/bundle.b64" \
  '{branch: $branch, bundle: $bundle} + (if $repository == "" then {} else {repository: $repository} end)' > "$work/parameters.json"
call push_branch
EOF
chmod 700 "$HOME/forgejo-push"`;
}

export function toolsSkillMarkdown(pluginId: string, tools: PluginToolDeclaration[]): string {
  const toolList = tools.map((tool) => `- \`${tool.name}\`: ${tool.description} Parameters: ${parameterList(tool)}.`);
  return [
    "---",
    `name: ${JSON.stringify("Forgejo tools")}`,
    `description: ${JSON.stringify(
      "Use when a task involves Forgejo issues or pull requests: searching, reading, commenting on, creating or updating issues, and opening, reading, reviewing, closing or merging pull requests. Also lists a repository's branches and reads its files.",
    )}`,
    "---",
    "",
    "# Forgejo tools",
    "",
    "The Forgejo plugin gives you tools for Forgejo issues, pull requests, branches and files.",
    "Paperclip does not put these tools in your tool list yet, so call them through the Paperclip API.",
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
    "## Push a branch",
    "",
    "In a Paperclip run, `git push` to Forgejo fails: `git` has no Forgejo credential. Push through",
    "the plugin instead, with this script. Create it once per run, because each run has a new `HOME`:",
    "",
    "```bash",
    pushScript(pluginId),
    "```",
    "",
    "Commit to a branch of your own, then push it and open a pull request with `create_pull_request`.",
    "Add `owner/repo` after the branch when the project uses several Forgejo repositories:",
    "",
    "```bash",
    '"$HOME/forgejo-push" my-branch',
    "```",
    "",
    "The script cannot push to the default branch or replace commits already pushed: to change pushed",
    "work, add commits rather than rewriting them. If it says \"Pushing is turned off\", say that you",
    "cannot push. Do not look for another credential.",
    "",
    "For the full parameter schemas:",
    "",
    "```bash",
    `curl -s -H "$AUTH" "$API/plugins/tools?pluginId=${pluginId}"`,
    "```",
    "",
  ].join("\n");
}
