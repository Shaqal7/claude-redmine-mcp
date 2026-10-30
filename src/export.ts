#!/usr/bin/env node
import { main } from "./export/cli.js";

await main(process.argv.slice(2));
