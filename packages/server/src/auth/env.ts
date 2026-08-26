/**
 * Full startup validation of every stubbed env var (DESIGN.md, "Deployment":
 * "the process refuses to start on a missing or malformed value") lands
 * with step 11 (Deployment) once every var is actually consumed. Until
 * then, reading one that OAuth needs and finding it unset is a clear 500
 * rather than signing a cookie with an empty secret or redirecting to a
 * malformed authorize URL.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}
