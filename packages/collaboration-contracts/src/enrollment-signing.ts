import { z } from 'zod'

import {
  installationIdSchema,
  timestampSchema,
  userIdSchema
} from './core.js'
import {
  deviceEnrollmentIdSchema,
  enrollmentNonceSchema
} from './identity-primitives.js'

export const DEVICE_ENROLLMENT_SIGNING_DOMAIN = 'SCIFORGE-DEVICE-ENROLLMENT-V1' as const

export const enrollmentSigningFactsSchema = z.object({
  enrollmentId: deviceEnrollmentIdSchema,
  nonce: enrollmentNonceSchema,
  userId: userIdSchema,
  installationId: installationIdSchema,
  expiresAt: timestampSchema
}).strict()

export type EnrollmentSigningFacts = z.infer<typeof enrollmentSigningFactsSchema>

/**
 * Canonical, client-safe bytes signed by a Device Ed25519 key during enrollment.
 *
 * The field order, UTF-8 encoding, domain separator, and LF delimiters are part
 * of the public contract. Callers must sign the returned bytes directly.
 */
export function canonicalEnrollmentBytes(input: EnrollmentSigningFacts): Uint8Array {
  const facts = enrollmentSigningFactsSchema.parse(input)
  return new TextEncoder().encode([
    DEVICE_ENROLLMENT_SIGNING_DOMAIN,
    facts.enrollmentId,
    facts.nonce,
    facts.userId,
    facts.installationId,
    facts.expiresAt
  ].join('\n'))
}
