import { readFileSync } from "node:fs";

/**
 * Resolves a config value that may be supplied either directly via `env[name]`
 * (dev convenience) or indirectly via `env[name + "_FILE"]` pointing at a mounted
 * Docker/Portainer secret file (production). Never logs the resolved value.
 */
export function readSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { required: boolean },
): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf8").trim();
  }

  const value = env[name];
  if (value) {
    return value;
  }

  if (options.required) {
    throw new Error(`${name} or ${name}_FILE is required`);
  }
  return undefined;
}
