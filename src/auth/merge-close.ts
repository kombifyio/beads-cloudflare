import { z } from "zod";
import { reusableKey, secretsMatch } from "../tracker/keys";
import { canonicalJson, sha256Hex } from "../tracker/util";
import { refuse } from "../tracker/problem";
import type { Principal } from "./scopes";

export const SCOPE_MERGE_CLOSE = "beads:merge-close";
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/);
const permitSchema = z.strictObject({
  repository, tracker: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/), head: sha,
  principal: z.string().min(1), worker: z.string().min(1),
  fence: z.number().int().nonnegative(), revision: z.string().regex(/^[0-9]+$/),
  expires: z.number().int().positive(),
});
export type MergePermit = z.infer<typeof permitSchema>;
export const mergeProofSchema = z.strictObject({
  repository, tracker_repository: repository, tracker: z.string(), id: z.string(), head: sha, commit: sha,
  member: z.number().int().positive(), permit: z.string().min(1).max(8192),
});
export type MergeProof = z.infer<typeof mergeProofSchema>;
const denied = () => refuse("forbidden", "Merge closure requires an exact holder permit, published head and trusted workflow proof.");

export const mergeReason = (proof: MergeProof) =>
  `Merged to main in ${proof.commit} (${proof.repository}#${proof.member}, head ${proof.head}).`;
export const mergeProofDigest = (proof: MergeProof) => sha256Hex(canonicalJson(proof));

export async function signMergePermit(secret: string, permit: MergePermit): Promise<string> {
  const data = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(permit))));
  const signature = await reusableKey(secret, `merge-close-permit-v1:${data}`);
  return `${data}.${signature.token}`;
}

export async function verifyMergeProof(secret: string, value: unknown): Promise<{ proof: MergeProof; permit: MergePermit }> {
  const parsed = mergeProofSchema.safeParse(value);
  if (!parsed.success) throw denied();
  const proof = parsed.data;
  const [data, signature, extra] = proof.permit.split(".");
  if (!data || !signature || extra !== undefined) throw denied();
  const expected = await reusableKey(secret, `merge-close-permit-v1:${data}`);
  if (!await secretsMatch(signature, expected.token)) throw denied();
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0)))); } catch { throw denied(); }
  const checked = permitSchema.safeParse(decoded);
  if (!checked.success) throw denied();
  const permit = checked.data;
  if (permit.expires <= Date.now() || permit.repository !== proof.repository || permit.tracker !== proof.tracker ||
      permit.id !== proof.id || permit.head !== proof.head) throw denied();
  return { proof, permit };
}

export async function verifyMergeCredential(principal: Principal, proof: MergeProof): Promise<void> {
  if (!principal.scopes?.includes(SCOPE_MERGE_CLOSE) ||
      !principal.sub.endsWith(`:merge-proof:${await mergeProofDigest(proof)}`)) throw denied();
}
