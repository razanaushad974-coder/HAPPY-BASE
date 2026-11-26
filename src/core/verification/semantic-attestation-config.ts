import {
  TrustedSemanticAttestationAuthority,
  type TrustedSemanticVerifierKey,
} from "./semantic-attestation";

/**
 * Parses operator-provisioned public verifier keys for a server composition.
 * The JSON value must come from deployment configuration, never request data.
 * Private signing keys must remain inside the external verifier service.
 */
export function createTrustedSemanticAttestationAuthority(
  serializedKeys: string | undefined,
): TrustedSemanticAttestationAuthority | null {
  if (serializedKeys === undefined || serializedKeys.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedKeys);
  } catch {
    throw new Error("HAPPY_SEMANTIC_VERIFIER_KEYS must contain valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HAPPY_SEMANTIC_VERIFIER_KEYS must be a non-empty JSON array.");
  }

  const keys: TrustedSemanticVerifierKey[] = parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`HAPPY_SEMANTIC_VERIFIER_KEYS[${index}] must be an object.`);
    }
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(",") !== "keyId,publicKeyPem,verifierId" ||
        typeof candidate.verifierId !== "string" ||
        typeof candidate.keyId !== "string" ||
        typeof candidate.publicKeyPem !== "string") {
      throw new Error(
        `HAPPY_SEMANTIC_VERIFIER_KEYS[${index}] must contain only verifierId, keyId, and publicKeyPem strings.`,
      );
    }
    return {
      verifierId: candidate.verifierId,
      keyId: candidate.keyId,
      publicKeyPem: candidate.publicKeyPem,
    };
  });

  return new TrustedSemanticAttestationAuthority(keys);
}
