import { z } from 'zod'
import type {
  DomainMainPackageSettingsHost,
  DomainMainPackageSettingsSnapshot
} from '@sciforge/domain-sdk/package-storage'

const collaborationSettingsSchema = z.object({
  schemaVersion: z.literal(3),
  baseUrl: z.url().max(2_048).refine((value) => new URL(value).protocol === 'https:'),
  deviceId: z.string().regex(/^dev_[A-Za-z0-9][A-Za-z0-9_]{10,62}[A-Za-z0-9]$/).optional(),
  agentId: z.string().regex(/^agt_[A-Za-z0-9]{12,64}$/).optional(),
  capabilityProfileRevision: z.number().int().positive().optional(),
  capabilityProfileExpiresAt: z.iso.datetime({ offset: true }).optional(),
  pendingCapabilityProfileReport: z.record(z.string(), z.json()).optional()
}).strict()

export type CollaborationSettings = z.infer<typeof collaborationSettingsSchema>

export class CollaborationSettingsService {
  constructor(private readonly host: DomainMainPackageSettingsHost) {}

  async read(): Promise<Readonly<{
    revision: number
    settings: CollaborationSettings | null
  }>> {
    const snapshot = await this.host.read()
    return {
      revision: snapshot.revision,
      settings: snapshot.value === null
        ? null
        : normalizeSettings(snapshot.value)
    }
  }

  async configure(baseUrl: string): Promise<CollaborationSettings> {
    const normalized = normalizeBaseUrl(baseUrl)
    return this.writeCurrent((current) => {
      if (!current) return { schemaVersion: 3, baseUrl: normalized }
      if (current.baseUrl === normalized) return current
      return { schemaVersion: 3, baseUrl: normalized }
    })
  }

  async bindDevice(deviceId: string): Promise<CollaborationSettings> {
    return this.writeCurrent((current) => {
      if (!current) throw new Error('Configure the collaboration service before binding a cloud Device.')
      if (current.deviceId === deviceId) return current
      const {
        agentId: _agentId,
        capabilityProfileRevision: _profileRevision,
        capabilityProfileExpiresAt: _profileExpiresAt,
        pendingCapabilityProfileReport: _pendingProfile,
        ...rest
      } = current
      return { ...rest, schemaVersion: 3, deviceId }
    })
  }

  async rememberAgent(agentId: string | undefined): Promise<CollaborationSettings> {
    return this.writeCurrent((current) => {
      if (!current) throw new Error('Configure the collaboration service before storing an Agent binding.')
      if (current.agentId === agentId) return current
      const {
        agentId: _previous,
        capabilityProfileRevision: _profileRevision,
        capabilityProfileExpiresAt: _profileExpiresAt,
        pendingCapabilityProfileReport: _pendingProfile,
        ...rest
      } = current
      return { ...rest, schemaVersion: 3, ...(agentId ? { agentId } : {}) }
    })
  }

  async releaseIdentity(): Promise<CollaborationSettings> {
    return this.writeCurrent((current) => {
      if (!current) throw new Error('Collaboration service is not configured.')
      return { schemaVersion: 3, baseUrl: current.baseUrl }
    })
  }

  async stageCapabilityProfileReport(request: unknown): Promise<CollaborationSettings> {
    const pendingCapabilityProfileReport = z.record(z.string(), z.json()).parse(request)
    return this.writeCurrent((current) => {
      if (!current?.agentId) throw new Error('An Agent binding is required before reporting capabilities.')
      return { ...current, pendingCapabilityProfileReport }
    })
  }

  async completeCapabilityProfileReport(
    revision: number,
    expiresAt: string
  ): Promise<CollaborationSettings> {
    return this.writeCurrent((current) => {
      if (!current?.agentId) throw new Error('An Agent binding is required before reporting capabilities.')
      const { pendingCapabilityProfileReport: _pending, ...rest } = current
      return {
        ...rest,
        capabilityProfileRevision: revision,
        capabilityProfileExpiresAt: expiresAt
      }
    })
  }

  async require(): Promise<CollaborationSettings> {
    const current = await this.read()
    if (!current.settings) throw new Error('Collaboration service is not configured.')
    return current.settings
  }

  private async writeCurrent(
    create: (current: CollaborationSettings | null) => CollaborationSettings
  ): Promise<CollaborationSettings> {
    let snapshot: DomainMainPackageSettingsSnapshot = await this.host.read()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = snapshot.value === null
        ? null
        : normalizeSettings(snapshot.value)
      const next = collaborationSettingsSchema.parse(create(current))
      try {
        const written = await this.host.write(next, snapshot.revision)
        return collaborationSettingsSchema.parse(written.value)
      } catch (error) {
        if (attempt > 0) throw error
        snapshot = await this.host.read()
      }
    }
    throw new Error('Unable to update collaboration settings.')
  }
}

function normalizeSettings(value: unknown): CollaborationSettings {
  return collaborationSettingsSchema.parse(value)
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Collaboration service URL must use HTTPS.')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Collaboration service URL cannot contain credentials, query, or fragment.')
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  return url.toString().replace(/\/$/u, '')
}
