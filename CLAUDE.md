# paperclip-plugin-forgejo

Paperclip plugin that connects Paperclip to Forgejo. Read `README.md` first: it explains why a
plugin can add Forgejo beside Paperclip's built-in GitHub support but cannot replace it.

## Names

- npm package: `@thomas-elliott/paperclip-plugin-forgejo` (public, published to npm)
- Plugin ID in Paperclip: `paperclip-plugin-forgejo`. Do not rename it: installed settings and
  state are keyed on it.
- Repository: `github.com/thomas-elliott/paperclip-plugin-forgejo` (public)

## Paperclip instances

- Production: a hosted Paperclip that cannot see this folder, so it only gets the plugin from npm:
  `npx paperclipai plugin install @thomas-elliott/paperclip-plugin-forgejo --api-base <production URL>`.
  Its address and deployment are in `CLAUDE.local.md`.
- Development: a throwaway local Paperclip on this laptop with its own data folder, so it never
  touches production state. Install from this folder with `npx paperclipai plugin install "$PWD"`
  and keep `pnpm dev` running; Paperclip reloads the worker when `dist/` changes.

## Plugin SDK reference

The SDK documentation is in the Paperclip repo, not in the npm package:
`doc/plugins/PLUGIN_AUTHORING_GUIDE.md` and `doc/plugins/PLUGIN_SPEC.md` in
`github.com/paperclipai/paperclip`. Type definitions are in
`node_modules/@paperclipai/plugin-sdk/dist/`.
