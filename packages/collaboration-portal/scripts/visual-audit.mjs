import axe from 'axe-core'
import pixelmatch from 'pixelmatch'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import { createServer } from 'vite'

const packageDirectory = resolve(fileURLToPath(new URL('../', import.meta.url)))
let portalDevServer
let auditUrl = process.env.PORTAL_AUDIT_URL
if (!auditUrl) {
  portalDevServer = await createServer({
    root: packageDirectory,
    base: '/portal/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false }
  })
  await portalDevServer.listen()
  const address = portalDevServer.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Portal visual audit could not resolve its local Vite port.')
  auditUrl = `http://127.0.0.1:${address.port}/portal/?demo=1`
}
const executablePath = process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const screenshotDirectory = process.env.PORTAL_AUDIT_SCREENSHOT_DIR
  ? resolve(process.env.PORTAL_AUDIT_SCREENSHOT_DIR)
  : await mkdtemp(resolve(tmpdir(), 'sciforge-portal-visual-'))
const baselineDirectory = resolve(fileURLToPath(new URL('../visual-baselines/', import.meta.url)))
const updateBaselines = process.env.PORTAL_UPDATE_VISUAL_BASELINES === '1'
const maximumDiffRatio = 0.001
await mkdir(screenshotDirectory, { recursive: true })
if (updateBaselines) await mkdir(baselineDirectory, { recursive: true })
const viewports = [
  { name: 'desktop', width: 1512, height: 982 },
  { name: 'tablet', width: 1024, height: 820 },
  { name: 'mobile', width: 390, height: 844 }
]
const reports = []
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath })
  for (const viewport of viewports) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport, colorScheme: theme, reducedMotion: 'reduce' })
      const runtimeErrors = []
      page.on('pageerror', (error) => runtimeErrors.push(error.message))
      // Freeze both `new Date()` and `Date.now()` before any application module
      // executes. Demo timestamps and relative-time labels must not make the
      // committed pixel baseline depend on wall-clock or runner speed.
      await page.addInitScript({ content: `(() => {
        const NativeDate = Date;
        const fixedNow = NativeDate.parse('2026-08-23T06:00:00.000Z');
        class PortalAuditDate extends NativeDate {
          constructor(...values) {
            super(...(values.length === 0 ? [fixedNow] : values));
          }
          static now() { return fixedNow; }
        }
        Object.defineProperty(globalThis, 'Date', {
          configurable: true,
          writable: true,
          value: PortalAuditDate
        });
      })();` })
      await page.goto(auditUrl, { waitUntil: 'networkidle' })
      await page.locator('.portal-shell').waitFor()
      await page.evaluate((selectedTheme) => { document.documentElement.dataset.theme = selectedTheme }, theme)
      await page.evaluate(async () => { await document.fonts.ready })
      await page.keyboard.press('Tab')
      const initialKeyboardFocus = await page.evaluate(() => {
        const element = document.activeElement
        return element instanceof HTMLElement && element !== document.body && element.tabIndex >= 0
      })
      const firstNode = page.locator('.constellation-node').first()
      await firstNode.focus()
      await page.keyboard.press('Enter')
      const constellationKeyboardSelection = await firstNode.getAttribute('aria-pressed') === 'true'
      const reducedMotion = await page.locator('.constellation-node--online .constellation-node__halo').first().evaluate((node) => {
        const durations = getComputedStyle(node).animationDuration.split(',').map((value) => Number.parseFloat(value) * (value.includes('ms') ? .001 : 1))
        return durations.every((duration) => duration <= .001)
      })
      await page.addScriptTag({ content: axe.source })
      const result = await page.evaluate(async () => globalThis.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
      }))
      const imageName = `portal-${viewport.name}-${theme}.png`
      const screenshot = resolve(screenshotDirectory, imageName)
      const baseline = resolve(baselineDirectory, imageName)
      const diff = resolve(screenshotDirectory, `diff-${imageName}`)
      await page.screenshot({ path: screenshot, animations: 'disabled' })
      let visualDiffPixels = 0
      let visualDiffRatio = 0
      let visualError = null
      if (updateBaselines) {
        await copyFile(screenshot, baseline)
      } else {
        try {
          const [actual, expected] = await Promise.all([readFile(screenshot), readFile(baseline)])
          const actualPng = PNG.sync.read(actual)
          const expectedPng = PNG.sync.read(expected)
          if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
            throw new Error(`visual dimensions changed from ${expectedPng.width}x${expectedPng.height} to ${actualPng.width}x${actualPng.height}`)
          }
          const diffPng = new PNG({ width: actualPng.width, height: actualPng.height })
          visualDiffPixels = pixelmatch(expectedPng.data, actualPng.data, diffPng.data, actualPng.width, actualPng.height, {
            includeAA: false,
            threshold: 0.1
          })
          visualDiffRatio = visualDiffPixels / (actualPng.width * actualPng.height)
          if (visualDiffPixels > 0) await writeFile(diff, PNG.sync.write(diffPng))
        } catch (error) {
          visualError = error instanceof Error ? error.message : String(error)
        }
      }
      reports.push({
        viewport: viewport.name,
        theme,
        screenshot,
        baseline,
        diff: visualDiffPixels > 0 ? diff : null,
        visualDiffPixels,
        visualDiffRatio,
        visualError,
        runtimeErrors,
        initialKeyboardFocus,
        constellationKeyboardSelection,
        reducedMotion,
        violations: result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }))
      })
      await page.close()
    }
  }
} finally {
  await browser?.close()
  await portalDevServer?.close()
}

process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
if (!updateBaselines && reports.some((report) => report.visualError || report.visualDiffRatio > maximumDiffRatio)) process.exitCode = 1
if (reports.some((report) => report.runtimeErrors.length > 0 || report.violations.length > 0 ||
    !report.initialKeyboardFocus || !report.constellationKeyboardSelection || !report.reducedMotion)) process.exitCode = 1
