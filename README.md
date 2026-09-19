# Anvil — Creative Workspace

[Live site](https://www.myriadanvil.com/) · [Public source](https://github.com/quanleok/anvil-portfolio)

Anvil is a workspace for organizing local project files, scripts, and media. This public source example combines an Electron desktop application with a developing Next.js browser workspace. The live site represents the broader product; this repository contains the public example and excludes private production methods.

## What is included

- File-backed projects, Markdown editing, project navigation, and an integrated terminal for user-installed tools.
- Asset organization, media previews, timeline editing, and configurable image, video, and audio provider integrations.
- Browser account and project interfaces, authenticated file and media APIs, and Supabase-backed storage.
- A basic assistant example with shared request/response contracts and generic workspace guidance.

**Stack:** TypeScript, React, Electron, Vite, Next.js, and Supabase.

Desktop and browser features have different levels of completeness. External integrations require your own service configuration. This is a source example, not a packaged production release or a claim of complete end-to-end validation.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Electron, React, and Vite desktop application |
| `src/app/` | Next.js website, browser workspace, and API routes |
| `src/server/` | Server-side assistant, project, and media modules |
| `src/shared/` | Shared types and API contracts |
| `supabase/migrations/` | Database schema migrations |
| `public/` | Web assets |
| `tests/` | Web application tests |
| `scripts/` | Development and packaging utilities |
| `docs/` | Public source documentation |

## Local development

Install Node.js and npm, then run from the repository root:

```bash
npm ci
```

For the web application, copy `.env.example` to `.env.local`, configure your own development services as needed, and run:

```bash
npm run dev:site
```

For the desktop application:

```bash
npm --prefix apps/desktop ci
npm run dev:desktop
```

Authentication, cloud storage, and model or media integrations require the corresponding service configuration. External API calls may incur charges. Keep actual credentials out of source control.

## Checks and builds

```bash
npm run test:unit
npm --prefix apps/desktop test
npm run build:site
npm run build:desktop
```

These commands are available for development; they are not a statement that every build or live integration has passed in this environment. Desktop packaging and signing need additional platform-specific configuration.

See the [desktop guide](apps/desktop/README.md) and [source documentation](docs/README.md) for the scope of this example.
