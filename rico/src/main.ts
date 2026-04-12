import { resolveConfig } from "./config";

const config = resolveConfig();

console.log(
  JSON.stringify({
    service: "rico",
    cwd: config.cwd,
    stateDir: config.stateDir,
    dbPath: config.dbPath,
    artifactDir: config.artifactDir,
    maxActiveProjects: config.maxActiveProjects,
  }),
);
