# Paperclip Forgejo plugin

A [Paperclip](https://paperclip.ing) plugin that connects a Paperclip instance to a self-hosted
Forgejo server, so agents can work with Forgejo the way they work with GitHub.

## What a plugin can and cannot do

Paperclip's GitHub support is built into the core server, not into a plugin. The repository
picker, GitHub connections and pull-request review threads all call `github.com` directly
(see `server/src/services/project-repositories.ts` in the Paperclip repo). A plugin cannot
swap those out.

A plugin can add a Forgejo integration that sits beside them, using these extension points:

| Need | Plugin feature | Capability |
| --- | --- | --- |
| Call the Forgejo API | `ctx.http.fetch` | `http.outbound` |
| Keep the access token out of config | `format: "secret-ref"` field, `ctx.secrets.resolve` | `secrets.read-ref` |
| Let agents open PRs, comment, read issues | `ctx.tools.register` | `agent.tools.register` |
| React to Forgejo events | webhooks | `webhooks.receive` |
| Show live status of pasted Forgejo PR and issue links | `objectReferences` | `external.objects.detect`, `external.objects.read` |
| Sync Forgejo issues into Paperclip | `ctx.issues` | `issues.create`, `issues.update` |
| Settings and status pages | UI slots | `ui.*.register` |

Cloning a Forgejo repository into an agent workspace works with an ordinary git URL; it does not
need this plugin.

## What works now

- Plugin settings for the Forgejo URL and an access token (stored as a Paperclip secret).
- A dashboard widget that checks the connection and shows the Forgejo version and user.
- A Forgejo tab on each project that lists your repositories and gives you the command to add one
  as a project workspace. Plugins cannot create workspaces themselves.

## Forgejo access token

Create the token in Forgejo under Settings, Applications, with these scopes:

| Scope | Used for |
| --- | --- |
| `read:user` | Checking the connection and showing who the token belongs to |
| `read:repository` | Listing repositories in the project tab |

Forgejo cannot change the scopes of an existing token, so create a new one if a scope is missing.

## Cloning private repositories

Paperclip clones a workspace's repository with plain `git` on the machine that runs the agent. It
only supplies credentials for github.com, and a plugin cannot supply them. For a private Forgejo
repository, set up git credentials for your Forgejo server on that machine first, such as a
credential helper with an access token or an SSH key. Without them the workspace is created but
the clone fails.

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

A local-path install runs this folder's code with full trust. To deploy, publish the package
to npm (or your own registry) and install it by name.

## References

- [Local plugin development](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md)
- [Plugin authoring guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md)
- [Plugin specification](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md)
- [Forgejo API](https://forgejo.org/docs/latest/user/api-usage/)
- Prior art for GitHub: [iMelki/paperclip-github-plugin](https://github.com/iMelki/paperclip-github-plugin),
  [mvanhorn/paperclip-plugin-github-issues](https://github.com/mvanhorn/paperclip-plugin-github-issues)
