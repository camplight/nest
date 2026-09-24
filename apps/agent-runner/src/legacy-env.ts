/** Keep stored wrapper commands and installed skills working during the Nest rename. */
export function withLegacyRunnerEnv(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NEST_")) result[`ORGOPS_${key.slice(5)}`] = value;
    else if (key.startsWith("ORGOPS_") && !(`NEST_${key.slice(7)}` in env)) {
      result[`NEST_${key.slice(7)}`] = value;
    }
  }
  return result;
}
