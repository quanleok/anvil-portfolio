# Public Source and Private Methods

This repository contains the workspace UI, local file tools, authentication,
project storage, provider integration, and a basic example assistant contract.
The private production methods and prompt recipes are maintained separately.

## Public example behavior

`src/server/anvil/methods.ts` keeps the request and response interface used by
`src/shared/anvil-api.ts`. It supplies a short generic assistant prompt. When no
model provider is configured, the fallback returns a visible explanation and
no file actions. It does not reproduce the private film workflow.

The desktop remains usable for project files, terminal work, media, and timeline
editing. Provider integrations require the developer's own configuration.
Authentication, access controls, path validation, and usage checks remain in
their existing server modules.

## Private deployment boundary

Keep private method implementations, recipes, credentials, internal deployment
records, and compiled releases outside the public repository. Do not add private
method text to desktop bundles, browser bundles, terminal prompts, test fixtures,
or archived copies. A server-only directory in a public repository is public
source code, even if it never reaches a browser bundle.

The private production deployment must be maintained separately. Do not deploy
this example over a production installation that requires the private methods.
Environment examples should contain placeholders; configure real values in the
private hosting environment.

## Publication limits

Removing files from the current branch does not remove older commits, tags,
release downloads, pull-request diffs, or cached copies. Those surfaces require
separate review before changing repository visibility. Do not describe a
current-tree cleanup as complete history erasure.
