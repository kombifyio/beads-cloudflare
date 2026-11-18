// CLI transcripts are a public surface; credentials stay in their custody files.
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === "string" && value) secrets.add(value);
  return value;
}

for (const [name, value] of Object.entries(process.env)) {
  if (/^(BEADS_.*TOKEN|ACCESS_CLIENT_SECRET|COOKIE_ENCRYPTION_KEY|ADMIN_TOKEN|CLOUDFLARE_API_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(name)) registerSecret(value);
}
for (let i = 2; i < process.argv.length; i++) {
  const match = /^--(?:token|access-client-secret)(?:=(.*))?$/.exec(process.argv[i]);
  if (match) registerSecret(match[1] ?? process.argv[i + 1]);
}

export function redact(value) {
  let text = String(value ?? "");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/\bbcf_[A-Za-z0-9_-]+/g, "[redacted]");
}
