# Forge Tool Layer

This folder is the tool-system entrypoint for Forge's AI agent.

## Structure

- `index.cjs`
  - Loads the built-in tool registry and auto-registers any custom tools.
- `builtins.cjs`
  - Existing Forge built-in tools.
- `custom/*.tool.cjs`
  - Local custom tools that should be available to the Forge agent.

## Custom Tool Contract

Drop a file into `custom/` with the suffix `.tool.cjs`.

Supported exports:

1. A function:

```js
module.exports = ({ registerTool, resolveInside }) => {
  registerTool("my_tool", {
    description: "Example custom tool.",
    args: { path: "relative path" },
    async run({ path }, ctx) {
      const absolute = resolveInside(ctx.projectDir, path);
      return { absolute };
    },
  });
};
```

2. An object with `register(api)`:

```js
module.exports = {
  register({ registerTool }) {
    registerTool("my_tool", {
      description: "Example custom tool.",
      args: {},
      async run() {
        return { ok: true };
      },
    });
  },
};
```

3. A single `{ name, definition }` export:

```js
module.exports = {
  name: "my_tool",
  definition: {
    description: "Example custom tool.",
    args: {},
    async run() {
      return { ok: true };
    },
  },
};
```

## Notes

- Tool names must be unique across built-ins and custom tools.
- Custom tools are loaded automatically on app start.
- `tools.cjs` remains the compatibility shim used by the rest of Forge.
