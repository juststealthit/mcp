// Marks the CLI entry executable, for `npx` and global installs on POSIX systems.
import { chmodSync } from "node:fs";

if (process.platform !== "win32") chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
