# Forgejo for Paperclip

This plugin connects [Paperclip](https://paperclip.ing) to your own [Forgejo](https://forgejo.org)
server. It adds Forgejo repositories to Paperclip projects, gives agents tools for Forgejo issues and
pull requests, shows the live status of Forgejo links, and can import Forgejo issues into Paperclip.

## What it does

- A dashboard widget shows whether Paperclip can reach Forgejo, the Forgejo version, and which user
  the token belongs to.
- A Forgejo tab on each project lists your repositories and marks the ones the project already
  uses. Pick a repository and add it as a workspace with one button, or copy the command that adds it.
- Agents get tools to search, read, create and update Forgejo issues, comment, open pull requests,
  list a pull request's files and read its checks. Agents leave out the repository when their project
  uses exactly one Forgejo repository. A **Forgejo tools** skill tells agents how to call the tools.
- Agents can merge pull requests only if you turn on **Let agents merge pull requests**. Forgejo
  branch protection still applies.
- A Forgejo issue or pull-request link in a Paperclip issue or comment shows its title and live
  status, such as Open, Closed, Draft or Merged.
- With **Import Forgejo issues** turned on, each project imports the open issues of the Forgejo
  repositories it uses, every five minutes or straight away through a webhook. Titles and
  descriptions follow Forgejo. Closing an issue on either side closes it on the other, and reopening
  it in Forgejo reopens it in Paperclip. Comments are not copied.
- Your Forgejo access token and webhook secret are stored as Paperclip secrets, not in plain settings.

## Limitations

- Paperclip does not let plugins create workspaces. The Add (experimental) button works around this by
  calling Paperclip's own API from the page, signed in as you. Paperclip does not promise to keep
  that API the same, so an update could break the button. The command in the Forgejo tab is the
  supported route and keeps working.
- Paperclip's built-in GitHub features, such as its repository picker and pull-request review
  threads, only work with github.com. This plugin adds Forgejo beside them and cannot replace them.
- Link status is an experimental Paperclip feature, off by default for GitHub links too. See
  [Show the status of Forgejo links](#show-the-status-of-forgejo-links).
- Pull requests that agents record on a task show as a plain title, not as Paperclip's GitHub
  pull-request card, which only recognises github.com.
- Paperclip does not yet put plugin tools in an agent's tool list. Agents call the Forgejo tools
  through Paperclip's API instead, as the Forgejo tools skill tells them, so each agent that uses
  Forgejo needs that skill. The tools only work on a task that belongs to a project.
- Agents act in Forgejo as the user who owns the access token.
- Reopening an imported issue in Paperclip does not reopen it in Forgejo.
- For a private repository, the machine that runs your agents needs its own git credentials for
  Forgejo, such as an SSH key or a credential helper with an access token. Paperclip only supplies
  credentials for github.com. Without them the workspace is created but the clone fails.

## Install

You need a Forgejo server, a Paperclip instance, and the right to install plugins in Paperclip.

1. In Forgejo, go to Settings, Applications, and create an access token with these scopes:

   | Scope | Used for |
   | --- | --- |
   | `read:user` | Checking the connection |
   | `write:issue` | Reading, creating, commenting on and closing issues |
   | `write:repository` | Listing repositories, and opening, reading and merging pull requests |

   For read-only use, `read:issue` and `read:repository` are enough, but agents then cannot comment,
   open pull requests or close imported issues.

2. Install the plugin into Paperclip:

   ```bash
   npx paperclipai plugin install @thomas-elliott/paperclip-plugin-forgejo --api-base https://your-paperclip.example.com
   ```

3. In Paperclip, open the Forgejo plugin's settings. Enter your Forgejo address, add the token as a
   secret, and save.
4. Check the Forgejo widget on the dashboard. It should show your Forgejo version and user.
5. Open a project in Paperclip and go to its Forgejo tab. Choose a repository and select Add
   (experimental). The repository appears under the project's Forgejo workspaces.

   If Add fails, the tab shows Paperclip's error. Select Copy command instead, run the command in a
   terminal, and reload the tab.
6. For each agent that should use Forgejo, open the agent's skills and turn on **Forgejo tools**.
   Saving the plugin settings added this skill to your company's skills.

The plugin now works. Agents with the skill can use the Forgejo tools in that project.

The plugin keeps the skill in step with its tools. If you edit the skill, the plugin replaces your
edits the next time you save its settings.

Forgejo cannot change an existing token's scopes. If a scope is missing, create a new token and
update the secret in Paperclip.

## Optional features

These are all off until you turn them on. Save the plugin settings after changing them.

### Import Forgejo issues

Turn on **Import Forgejo issues**. Every five minutes, each project imports the open issues of the
Forgejo repositories it uses.

### Update imported issues straight away

Without a webhook, imported issues update every five minutes. To update them straight away:

1. Choose a long random secret and save it in the plugin settings as **Webhook secret**.
2. In Forgejo, open the repository's or organisation's Settings, Webhooks, and add a Forgejo webhook:
   - Target URL: `https://your-paperclip.example.com/api/plugins/paperclip-plugin-forgejo/webhooks/forgejo`
   - HTTP method: POST, content type: `application/json`
   - Secret: the same secret
   - Trigger on: custom events, then **Issues**
3. Use Test Delivery in Forgejo. Paperclip records each delivery. A delivery fails if the secret does
   not match.

### Let agents merge pull requests

Turn on **Let agents merge pull requests**. Forgejo branch protection still applies.

### Show the status of Forgejo links

In Paperclip's instance settings, turn on the experimental **External objects** setting. Forgejo
issue and pull-request links in Paperclip issues and comments then show their title and status.

## Upgrade

If a new version of the plugin needs more permissions, Paperclip refuses the upgrade. Uninstall the
plugin and install it again; your settings are kept. Do not add `--force`, which deletes them.

```bash
npx paperclipai plugin uninstall paperclip-plugin-forgejo --api-base https://your-paperclip.example.com
npx paperclipai plugin install @thomas-elliott/paperclip-plugin-forgejo --api-base https://your-paperclip.example.com
```

After upgrading, open the plugin settings and save them once. Until you do, the five-minute import
and the webhook cannot find your company.

## Technical details

Paperclip's GitHub support is built into its core server, not into a plugin, so a plugin cannot swap
it out. The plugin builds on these extension points instead:

| Need | Plugin feature | Capability |
| --- | --- | --- |
| Call the Forgejo API | `ctx.http.fetch` | `http.outbound` |
| Keep the access token out of config | `format: "secret-ref"` field, `ctx.secrets.resolve` | `secrets.read-ref` |
| Read project workspaces | `ctx.projects` | `projects.read`, `project.workspaces.read` |
| Settings, dashboard and project tab | UI slots | `ui.*.register` |
| Let agents open PRs, comment, read issues | `ctx.tools.register` | `agent.tools.register` |
| Tell agents how to call those tools | managed skill, `ctx.skills.managed` | `skills.managed` |
| React to Forgejo events | webhooks | `webhooks.receive` |
| Show live status of pasted Forgejo PR and issue links | `objectReferences` | `external.objects.detect`, `external.objects.read` |
| Sync Forgejo issues into Paperclip | `ctx.issues`, a scheduled job, `issue.updated` events | `issues.read`, `issues.create`, `issues.update`, `jobs.schedule`, `events.subscribe` |
| Remember sync state | `ctx.state` | `plugin.state.read`, `plugin.state.write` |

The project tab recognises a workspace by any address Forgejo gives the repository: the HTTPS clone
address, the SSH address or the web address.

## Development

Needs Node.js 24.11 or later and pnpm.

```bash
pnpm install
pnpm dev        # rebuilds dist/ on every save
pnpm test
pnpm typecheck
```

Install into a running Paperclip from this folder. Paperclip reloads the worker when `dist/`
changes, so keep `pnpm dev` running:

```bash
npx paperclipai plugin install "$PWD"
npx paperclipai plugin inspect paperclip-plugin-forgejo   # the plugin ID, not the npm name
```

A local-path install runs this folder's code with full trust. Paperclip only rereads the manifest
on an upgrade, so run `npx paperclipai plugin upgrade paperclip-plugin-forgejo` after changing it.

## References

- [Local plugin development](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md)
- [Plugin authoring guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md)
- [Plugin specification](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md)
- [Forgejo API](https://forgejo.org/docs/latest/user/api-usage/)
- Prior art for GitHub: [iMelki/paperclip-github-plugin](https://github.com/iMelki/paperclip-github-plugin),
  [mvanhorn/paperclip-plugin-github-issues](https://github.com/mvanhorn/paperclip-plugin-github-issues)
