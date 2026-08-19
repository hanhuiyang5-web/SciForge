import { z } from 'zod'

const opaqueSuffix = '[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])'

export const deviceEnrollmentIdSchema = z.string().regex(
  new RegExp(`^enr_${opaqueSuffix}$`, 'u')
)

export const enrollmentNonceSchema = z.string().min(43).max(512).refine(
  (value) => isCanonicalBase64UrlBytes(value, { min: 32 }),
  { message: 'Device enrollment nonce must be canonical base64url for at least 32 bytes' }
)

/** Browser-safe validation for canonical, unpadded base64url. */
export function isCanonicalBase64UrlBytes(
  value: string,
  expectedBytes: number | { min: number }
): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return false

  const trailingBits = value.length % 4
  const lastValue = base64UrlValue(value.at(-1)!)
  if ((trailingBits === 2 && (lastValue & 0b1111) !== 0) ||
      (trailingBits === 3 && (lastValue & 0b11) !== 0)) {
    return false
  }

  const decodedLength = Math.floor(value.length * 6 / 8)
  return typeof expectedBytes === 'number'
    ? decodedLength === expectedBytes
    : decodedLength >= expectedBytes.min
}

function base64UrlValue(character: string): number {
  const code = character.charCodeAt(0)
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  return character === '-' ? 62 : 63
}
