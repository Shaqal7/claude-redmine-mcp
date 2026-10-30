import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import dotenv from "dotenv";

import { isRedmineMcpError } from "../errors.js";
import type { RedmineState } from "./exporter.js";

const USAGE = `Użycie: redmine-export --projects a,b --out <katalog> [opcje]

  --projects <a,b>      identyfikatory projektów (muszą być na allowliście REDMINE_ALLOWED_PROJECTS)
  --out <katalog>       katalog wyjściowy (<slug>.jsonl, przy --reconcile <slug>.ids.json)
  --state <plik>        plik stanu (brak pliku = pusty stan); nigdy nie jest zmieniany
  --state-out <plik>    tu trafia proponowany nowy stan (pomijany przy --reconcile)
  --env <ścieżka>       plik .env z REDMINE_* (domyślnie .env w bieżącym katalogu)
  --since <ISO>         początek okna zamiast stanu (np. 2026-10-01T00:00:00Z)
  --ignore-state        pełny eksport, bez okna od stanu
  --reconcile           zapisz tylko listę ID (<slug>.ids.json), bez stanu
  --page-size <n>       rozmiar strony listowania (domyślnie 100)
  --help                to ekran

Kody wyjścia: 0 sukces, 1 błąd, 2 POLICY_ERROR (projekt poza allowlistą).
`;

async function readState(path: string | undefined): Promise<RedmineState> {
  if (!path) {
    return { projects: {} };
  }
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { projects: {} };
    }
    throw error;
  }
  const parsed = JSON.parse(text.replace(/^﻿/, "")) as Partial<RedmineState>;
  return { projects: parsed.projects ?? {} };
}

/** Zapis przez plik tymczasowy + rename, żeby awaria nie zostawiła częściowego pliku. */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

export async function main(argv: string[]): Promise<void> {
  const log = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        projects: { type: "string" },
        out: { type: "string" },
        state: { type: "string" },
        "state-out": { type: "string" },
        env: { type: "string" },
        since: { type: "string" },
        "ignore-state": { type: "boolean", default: false },
        reconcile: { type: "boolean", default: false },
        "page-size": { type: "string" },
        help: { type: "boolean", default: false }
      },
      strict: true
    });

    if (values.help) {
      process.stdout.write(USAGE);
      return;
    }
    if (!values.projects || !values.out) {
      log("Brak wymaganych argumentów --projects i --out (zobacz --help).");
      process.exitCode = 1;
      return;
    }
    const pageSize = values["page-size"] === undefined ? undefined : Number.parseInt(values["page-size"], 10);
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
      log("--page-size musi być liczbą całkowitą 1-100.");
      process.exitCode = 1;
      return;
    }
    if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) {
      log("--since musi być datą ISO.");
      process.exitCode = 1;
      return;
    }

    // .env musi być wczytany PRZED importem config.js (który ładuje "dotenv/config" z bieżącego katalogu).
    if (values.env) {
      dotenv.config({ path: values.env, quiet: true });
    }
    const { loadConfig } = await import("../config.js");
    const { RedmineClient } = await import("../redmine/client.js");
    const { ProjectPolicy } = await import("../redmine/policy.js");
    const { exportProjects, reconcileProjects } = await import("./exporter.js");

    const config = loadConfig();
    const common = {
      client: new RedmineClient(config),
      policy: new ProjectPolicy(config.allowedProjects),
      projects: values.projects.split(",").map((p) => p.trim()).filter(Boolean),
      outDir: values.out,
      now: () => new Date(),
      pageSize,
      log,
      writeFile: atomicWrite
    };

    if (values.reconcile) {
      const result = await reconcileProjects(common);
      log(`reconcile done: ${JSON.stringify(result.written)}`);
      return;
    }

    const state = await readState(values.state);
    const result = await exportProjects({
      ...common,
      state,
      ignoreState: values["ignore-state"],
      since: values.since
    });
    if (values["state-out"]) {
      await atomicWrite(values["state-out"], `${JSON.stringify(result.nextState, null, 2)}\n`);
    }
    log(`export done: ${JSON.stringify(result.written)}`);
  } catch (error) {
    if (isRedmineMcpError(error)) {
      log(`${error.code}: ${error.message}`);
      process.exitCode = error.code === "POLICY_ERROR" ? 2 : 1;
    } else {
      log(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
