#!/usr/bin/env bun
import { run } from "../src/cli.ts";

run(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
