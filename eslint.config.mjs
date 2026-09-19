import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**/*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/admin",
              message: "Supabase service-role clients are server-only. Use them only from API routes or server modules.",
            },
            {
              name: "@/lib/desktop-tokens/server",
              message: "Desktop token server helpers use service-role access and must stay out of client-facing code.",
            },
            {
              name: "@/lib/billing/server",
              message: "Billing server helpers use service-role access and must stay out of client-facing code.",
            },
            {
              name: "@/lib/usage/server",
              message: "Usage ledger server helpers use service-role access and must stay out of client-facing code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/**/server.ts",
      "src/lib/supabase/admin.ts",
      "src/lib/usage/server.ts",
      "src/lib/billing/server.ts",
      "src/lib/desktop-tokens/server.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/admin",
              message: "Supabase service-role clients must stay in explicit server-only modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/electron/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["apps/desktop/**/*.{ts,tsx}"],
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "apps/desktop/dist/**",
    "apps/desktop/node_modules/**",
  ]),
]);

export default eslintConfig;
