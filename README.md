# Forgejo for Paperclip

This plugin connects [Paperclip](https://paperclip.ing) to your own [Forgejo](https://forgejo.org)
server. It checks the connection, lists your Forgejo repositories, and helps you add them to
Paperclip projects.

## What it does

- A dashboard widget shows whether Paperclip can reach Forgejo, the Forgejo version, and which user
  the token belongs to.
- A Forgejo tab on each project lists your repositories and marks the ones the project already
  uses. Pick a repository and the tab gives you the command that adds it as a workspace.
- Your Forgejo access token is stored as a Paperclip secret, not in plain settings.

## Limitations

- The plugin cannot add a workspace itself, because Paperclip does not let plugins create
  workspaces. You copy the command from the Forgejo tab and run it.
- Paperclip's built-in GitHub features, such as its repository picker and pull-request review
  threads, only work with github.com. This plugin adds Forgejo beside them and cannot replace them.
- Agents cannot yet open pull requests or read issues through the plugin.
- For a private repository, the machine that runs your agents needs its own git credentials for
  Forgejo, such as an SSH key or a credential helper with an access token. Paperclip only supplies
  credentials for github.com. Without them the workspace is created but the clone fails.

## Install

1. In Forgejo, go to Settings, Applications, and create an access token with these scopes:

   | Scope | Used for |
   | --- | --- |
   | `read:user` | Checking the connection |
   | `read:repository` | Listing your repositories |

2. Install the plugin into Paperclip:

   ```bash
   npx paperclipai plugin install @thomas-elliott/paperclip-plugin-forgejo --api-base https://your-paperclip.example.com
   ```

3. In Paperclip, open the Forgejo plugin's settings. Enter your Forgejo address, add the token as a
   secret, and save.
4. Check the Forgejo widget on the dashboard. It should show your Forgejo version and user.

Forgejo cannot change an existing token's scopes. If a scope is missing, create a new token and
update the secret in Paperclip.

### Upgrading

If a new version of the plugin needs more permissions, Paperclip refuses the upgrade. Uninstall the
plugin and install it again. Your settings are kept.

## Add a Forgejo repository to a project

1. Open the project in Paperclip and go to the Forgejo tab.
2. Choose a repository and select Copy command.
3. Run the command in a terminal.
4. Reload the tab. The repository now appears under the project's Forgejo workspaces.

## Technical details

Paperclip's GitHub support is built into its core server, not into a plugin, so a plugin cannot swap
it out. The plugin builds on these extension points instead, and the later rows are candidates for
future features:

| Need | Plugin feature | Capability |
| --- | --- | --- |
| Call the Forgejo API | `ctx.http.fetch` | `http.outbound` |
| Keep the access token out of config | `format: "secret-ref"` field, `ctx.secrets.resolve` | `secrets.read-ref` |
| Read project workspaces | `ctx.projects` | `projects.read`, `project.workspaces.read` |
| Settings, dashboard and project tab | UI slots | `ui.*.register` |
| Let agents open PRs, comment, read issues | `ctx.tools.register` | `agent.tools.register` |
| React to Forgejo events | webhooks | `webhooks.receive` |
| Show live status of pasted Forgejo PR and issue links | `objectReferences` | `external.objects.detect`, `external.objects.read` |
| Sync Forgejo issues into Paperclip | `ctx.issues` | `issues.create`, `issues.update` |

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
