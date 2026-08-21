import { describe, expect, it, vi } from 'vitest'
import { CloudIdentitySessionBroker } from './session.js'

describe('CloudIdentitySessionBroker', () => {
  it('keeps the active credential in memory and clears all subscribers on logout', () => {
    const broker = new CloudIdentitySessionBroker()
    const listener = vi.fn()
    broker.subscribe(listener)
    broker.publish({
      cloudBaseUrl: 'https://cloud-test.sciforge.cn/',
      accessToken: 'access-token-without-whitespace',
      userId: 'usr_CloudIdentity0001',
      deviceId: 'dev_CloudDevice00001'
    })
    expect(broker.current()).toEqual({
      cloudBaseUrl: 'https://cloud-test.sciforge.cn',
      accessToken: 'access-token-without-whitespace',
      userId: 'usr_CloudIdentity0001',
      deviceId: 'dev_CloudDevice00001'
    })
    broker.clear()
    expect(broker.current()).toBeNull()
    expect(listener).toHaveBeenLastCalledWith(null)
  })
})
