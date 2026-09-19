import { readdirSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(process.cwd(), "supabase", "migrations");
const bareTimestamp = /^\d+\.sql$/;
const invalid = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .filter((name) => bareTimestamp.test(name));

if (invalid.length > 0) {
  console.error("Migration filenames need a descriptive suffix:");
  for (const name of invalid) console.error(`- ${name}`);
  process.exit(1);
}
