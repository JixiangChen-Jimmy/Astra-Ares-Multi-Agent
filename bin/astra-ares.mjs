#!/usr/bin/env node
import { launch } from "../src/launch.mjs";
try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22+ is required");
  process.exitCode = await launch(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
