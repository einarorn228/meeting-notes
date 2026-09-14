// Drives the built app headlessly with Playwright and captures screenshots for the user guide.
// Usage: xvfb-run -a node scripts/screenshots.mjs   (requires `npm run build` first)
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const out = 'docs/img'
mkdirSync(out, { recursive: true })
const userData = join(homedir(), '.config', 'Fundarritari')
// Fresh onboarding state (keep models/sidecar links, drop settings + meetings).
if (existsSync(join(userData, 'settings.json'))) rmSync(join(userData, 'settings.json'))
if (existsSync(join(userData, 'data', 'meetings'))) rmSync(join(userData, 'data', 'meetings'), { recursive: true, force: true })

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu', '--use-fake-device-for-media-capture', '--use-fake-ui-for-media-stream'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1240, height: 820 })
const shot = async (name) => {
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, name + '.png') })
  console.log('shot', name)
}
const click = async (text) => {
  await page.getByRole('button', { name: text, exact: false }).first().click()
}

await page.waitForSelector('text=Velkomin í Fundarritara')
await shot('01-velkomin')
await click('Byrjum')
await shot('02-hljodnemi')
await click('Áfram')
await shot('03-kerfishljod')
await click('Áfram')
await shot('04-profun')
await click('Áfram')
await shot('05-talgreining')
await click('Áfram')
await shot('06-gervigreind')
await click('Áfram')
await shot('07-tilbuid')
await click('Opna Fundarritara')
await page.waitForSelector('text=Fundir')
await shot('08-forsida')

// Recording view (fake mic; system audio unavailable in this environment → shows the warning banner)
await click('Hefja upptöku')
await page.waitForSelector('text=Uppskrift í beinni', { timeout: 60000 })
await page.waitForTimeout(2500)
await shot('09-upptaka')
await click('Stöðva upptöku')
await page.waitForTimeout(3000)
await shot('10-fundur')

// Settings
await page.getByRole('button', { name: 'Stillingar', exact: true }).first().click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Talgreining', exact: true }).first().click()
await shot('11-stillingar-talgreining')
await page.getByRole('button', { name: 'Gervigreind', exact: true }).first().click()
await shot('12-stillingar-gervigreind')
await page.getByRole('button', { name: 'Orðaforði', exact: true }).first().click()
await shot('13-stillingar-ordafordi')
await app.close()
