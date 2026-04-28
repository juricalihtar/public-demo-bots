import eywa from 'eywa-client'
import { chromium } from 'playwright'

const SEASON_URL = {
  summer:    'https://www.njuskalo.hr/gume-ljetne',
  winter:    'https://www.njuskalo.hr/gume-zimske',
  allseason: 'https://www.njuskalo.hr/gume-cjelogodisnje',
}

async function selectByText(page, selectName, targetText) {
  const sel = page.locator(`select[name="${selectName}"]`)
  const options = await sel.locator('option').all()
  for (const opt of options) {
    const text = (await opt.textContent()).trim()
    if (text === String(targetText)) {
      const value = await opt.getAttribute('value')
      await sel.selectOption(value)
      return true
    }
  }
  return false
}

async function getOptionValue(page, selectName, targetText) {
  return await page.evaluate(({ name, text }) => {
    const sel = document.querySelector(`select[name="${name}"]`)
    if (!sel) return null
    for (const opt of sel.options) {
      if (opt.text.trim() === String(text)) return opt.value
    }
    return null
  }, { name: selectName, text: targetText })
}

async function acceptCookies(page) {
  try {
    const btn = page.locator('button, a').filter({ hasText: /prihvati i zatvori|prihvati sve|accept all/i }).first()
    await btn.click({ timeout: 4000 })
    eywa.info('Cookie dialog prihvaćen')
    await page.waitForTimeout(800)
  } catch {
    eywa.info('Nema cookie dialoga')
  }
}

async function scrapeNjuskalo(page, width, profile, rim, season, maxResults) {
  const baseUrl = SEASON_URL[season] || SEASON_URL.summer

  // Korak 1: Učitaj baznu stranicu i prihvati cookies
  eywa.info(`Otvaranje: ${baseUrl}`)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1500)
  await acceptCookies(page)

  // Korak 2: Dohvati widthId vrijednost za traženu širinu
  const widthId = await getOptionValue(page, 'widthId', width)
  if (!widthId) { eywa.warn(`Širina ${width} nije pronađena`); }
  else eywa.info(`widthId za ${width}mm = ${widthId}`)

  // Korak 3: Navigiraj s widthId da se ratioId opcije ažuriraju
  const url1 = `${baseUrl}?widthId=${widthId}`
  eywa.info(`Navigiram: ${url1}`)
  await page.goto(url1, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1000)

  // Korak 4: Dohvati ratioId za traženi profil
  const ratioId = await getOptionValue(page, 'ratioId', profile)
  if (!ratioId) { eywa.warn(`Profil ${profile} nije pronađen`) }
  else eywa.info(`ratioId za ${profile} = ${ratioId}`)

  // Korak 5: Navigiraj s widthId + ratioId da se diameterId ažurira
  const url2 = `${baseUrl}?widthId=${widthId}&ratioId=${ratioId}`
  eywa.info(`Navigiram: ${url2}`)
  await page.goto(url2, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1000)

  // Korak 6: Dohvati diameterId za traženi promjer
  const diameterId = await getOptionValue(page, 'diameterId', rim)
  if (!diameterId) { eywa.warn(`Promjer ${rim} nije pronađen`) }
  else eywa.info(`diameterId za ${rim}" = ${diameterId}`)

  // Korak 7: Navigiraj na konačni URL s filtreima
  const finalUrl = `${baseUrl}?widthId=${widthId}&ratioId=${ratioId}&diameterId=${diameterId}`
  eywa.info(`Finalni URL: ${finalUrl}`)
  await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2000)

  await page.screenshot({ path: 'debug_results.png', fullPage: false })

  // Scrape oglase
  const results = await page.evaluate((max) => {
    const items = []
    const cards = document.querySelectorAll('.EntityList-item--Regular, .EntityList-item--MVIPrimary')
    cards.forEach(card => {
      if (items.length >= max) return
      const titleEl = card.querySelector('.entity-title a, h3 a, .entity-description-title a')
      const title = titleEl?.textContent?.trim() || ''
      const priceEl = card.querySelector('.price-box--regular, .price-box, [class*="price"]')
      const price = priceEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
      const href = titleEl?.href || card.querySelector('a')?.href || ''
      const link = href.startsWith('http') ? href : `https://www.njuskalo.hr${href}`
      if (title) items.push({ title, price, link, source: 'Njuškalo' })
    })
    return items
  }, maxResults)

  eywa.info(`Pronađeno ${results.length} oglasa`)
  return results
}

function parsePrice(priceStr) {
  if (!priceStr) return null
  const clean = priceStr.replace(/\s/g, '').replace(/[€$£]/g, '')
  const match = clean.match(/[\d]+[.,]?[\d]*/)
  if (!match) return null
  return parseFloat(match[0].replace(',', '.'))
}

async function main() {
  eywa.open_pipe()

  let browser = null
  try {
    const task = await eywa.get_task()
    eywa.info(`Raw task: ${JSON.stringify(task)}`)

    // task.data dolazi od eywa run --task-json
    const data = task?.data || {}
    const width      = Number(data.width    ?? 205)
    const profile    = Number(data.profile  ?? 55)
    const rim        = Number(data.rim      ?? 16)
    const season     = String(data.season   ?? 'summer')
    const maxResults = Number(data.maxResults ?? 10)

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Pretraga: ${width}/${profile}R${rim} | Sezona: ${season}`)

    browser = await chromium.launch({ headless: false, slowMo: 200 })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'hr-HR',
      viewport: { width: 1280, height: 900 },
    })

    const page = await context.newPage()
    const results = await scrapeNjuskalo(page, width, profile, rim, season, maxResults)
    await browser.close()
    browser = null

    if (results.length === 0) {
      eywa.warn('Nema rezultata. Provjeri debug_results.png')
      eywa.report('Nema rezultata', { dimenzije: `${width}/${profile}R${rim}`, sezona: season })
      eywa.close_task(eywa.SUCCESS)
      return
    }

    const prices = results.map(r => parsePrice(r.price)).filter(Boolean)
    const sorted = [...results].sort((a, b) => (parsePrice(a.price) || Infinity) - (parsePrice(b.price) || Infinity))

    eywa.report(
      `Njuškalo: ${width}/${profile}R${rim} (${season})`,
      {
        dimenzije: `${width}/${profile}R${rim}`,
        sezona: season,
        ukupno: results.length,
        min_cijena: prices.length ? Math.min(...prices) : null,
        max_cijena: prices.length ? Math.max(...prices) : null,
        rezultati: sorted,
      }
    )

    eywa.info(`Gotovo. ${results.length} oglasa, cijene: ${Math.min(...prices)} - ${Math.max(...prices)} €`)
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    if (browser) { try { await browser.close() } catch {} }
    eywa.error(`Greška: ${err.message}\n${err.stack}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
