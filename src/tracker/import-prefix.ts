/** Guarded recovery may retain an existing identity; it never admits a new foreign identity. */
export function admitsImportIdentity(id: string, prefixes: string[], guarded: boolean, existsInTracker: boolean): boolean {
  return (guarded && existsInTracker) || prefixes.some(prefix => id.startsWith(`${prefix}-`));
}
