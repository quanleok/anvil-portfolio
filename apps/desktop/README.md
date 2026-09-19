# Anvil Desktop

The desktop workspace uses Electron, React, Vite, and TypeScript. Projects live in user-selected folders, with editable Markdown files and a media library.

## Included surfaces

- Project navigation and Markdown editing.
- An integrated terminal for local tools installed by the user.
- Asset management, media previews, and timeline editing.
- Provider adapters for configured image, video, and audio services.
- Generic assistant guidance and workspace file tools.

These surfaces are under development. External services and user-installed command-line tools have their own setup requirements. The included assistant is a basic workspace example.

## Run locally

From the repository root:

```bash
npm ci
npm --prefix apps/desktop ci
npm run dev:desktop
```

Use the application to open or create a project folder. Work with local files first, then configure a provider only when needed for the requested media operation. Keep provider credentials in local settings or your private environment, never in committed project files.

## Project files

Creative files live in folders such as `story/`, `script/`, `scenes/`, `prompts/`, and `assets/`. Application metadata and session state live under `.forge/`. Existing projects may contain additional compatibility folders.

A local terminal or external agent runs with the permissions of the current user. Review file changes and external API actions before relying on them.

## Development checks

```bash
npm --prefix apps/desktop test
npm --prefix apps/desktop run check:types
npm run build:desktop
```

These commands document the available checks; they do not certify a production release. Installer signing and distribution require separate configuration.

See the [repository overview](../../README.md) and [public source boundary](../../docs/09-protected-server-split.md).
