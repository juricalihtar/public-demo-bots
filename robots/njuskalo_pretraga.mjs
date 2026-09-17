import eywa from 'eywa-client'
import { chromium } from 'playwright'

const HOME = 'https://www.njuskalo.hr/'

// Labeli u <select name="sort"> na Njuškalu
const SORT_LABELS = {
  najjeftinije: 'S nižom cijenom',
  najskuplje:   'S višom cijenom',
  najnovije:    'Najnoviji',
  najstarije:   'Najstariji',
  relevantnost: 'Relevantnost',
}

function parsePrice(text) {
  if (!text) return null
  // "1.250 €" -> 1250, "140 €" -> 140
  const clean = String(text).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const m = clean.match(/\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

async function prihvatiKolacice(page) {
  const gumb = page.locator('#didomi-notice-agree-button')
  try {
    // Dialog se pojavljuje s odgodom, a dok mu backdrop ne nestane
    // presreće klikove po cijeloj stranici — zato se čeka i pojava i nestanak
    await gumb.waitFor({ state: 'visible', timeout: 10000 })
  } catch {
    eywa.info('Nema cookie dialoga')
    return
  }

  await gumb.click()
  await page.locator('#didomi-popup').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
  eywa.info('Kolačići prihvaćeni')
}

async function upisiPojam(page, pojam) {
  eywa.info(`Upisujem pojam "${pojam}" u tražilicu`)
  await page.click('#keywords')
  await page.fill('#keywords', pojam)
  await page.waitForTimeout(400)
  await page.press('#keywords', 'Enter')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
}

async function postaviCijenu(page, cijenaOd, cijenaDo) {
  if (cijenaOd == null && cijenaDo == null) return false

  // Bočni filteri se renderiraju sekundu-dvije nakon rezultata, pa se čeka
  // na samo polje umjesto na fiksnu pauzu
  try {
    await page.locator('#searchForm-price-min').waitFor({ state: 'visible', timeout: 20000 })
  } catch {
    eywa.warn('Filter cijene se nije pojavio — nastavljam bez njega')
    return false
  }

  if (cijenaOd != null) await page.fill('#searchForm-price-min', String(cijenaOd))
  if (cijenaDo != null) await page.fill('#searchForm-price-max', String(cijenaDo))

  // Filter se primjenjuje tek na Enter — sam upis ne submita formu
  const zadnjePolje = cijenaDo != null ? '#searchForm-price-max' : '#searchForm-price-min'
  await page.press(zadnjePolje, 'Enter')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // Njuškalo filter upisuje u URL; ako ga nema, nije primijenjen
  if (!/price(%5B|\[)min/.test(page.url()) && !/price(%5B|\[)max/.test(page.url())) {
    eywa.warn('Filter cijene nije prihvaćen — rezultati nisu ograničeni cijenom')
    return false
  }

  eywa.info(`Primijenjen filter cijene: ${cijenaOd ?? '—'} - ${cijenaDo ?? '—'} €`)
  return true
}

async function postaviSort(page, sortiraj) {
  if (sortiraj === 'relevantnost') return
  const label = SORT_LABELS[sortiraj]

  const sel = page.locator('#searchForm-sort')
  try {
    await sel.waitFor({ state: 'visible', timeout: 20000 })
  } catch {
    eywa.warn('Sortiranje se nije pojavilo — nastavljam bez njega')
    return
  }

  // Ovaj select sam submita formu pri promjeni
  await sel.selectOption({ label })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  eywa.info(`Sortirano: ${label}`)
}

async function pokupiOglase(page, maxResults) {
  return page.evaluate((max) => {
    const items = []
    const cards = document.querySelectorAll('.EntityList-item--Regular, .EntityList-item--VauVau')

    for (const card of cards) {
      if (items.length >= max) break

      const titleEl = card.querySelector('.entity-title a')
      const naslov = titleEl?.querySelector('span')?.textContent?.trim()
        || titleEl?.textContent?.trim()
      if (!naslov) continue

      const cijena = card.querySelector('.price--hrk, .price-item')
        ?.textContent?.trim().replace(/\s+/g, ' ') || null

      const opis = card.querySelector('.entity-description')
        ?.textContent?.trim().replace(/\s+/g, ' ') || ''
      const lokacija = opis.replace(/^Lokacija:\s*/i, '') || null

      const datum = card.querySelector('.entity-pub-date')
        ?.textContent?.trim().replace(/^Objavljen:\s*/i, '') || null

      const href = titleEl?.getAttribute('href') || ''
      const link = href.startsWith('http') ? href : `https://www.njuskalo.hr${href}`

      items.push({ naslov, cijena, lokacija, datum, link })
    }
    return items
  }, maxResults)
}

async function main() {
  eywa.open_pipe()

  let browser = null
  try {
    const task = await eywa.get_task()
    const data = task?.data || {}

    const pojam = String(data.pojam ?? 'bicikl').trim()
    const cijenaOd = data.cijenaOd === '' || data.cijenaOd == null ? null : Number(data.cijenaOd)
    const cijenaDo = data.cijenaDo === '' || data.cijenaDo == null ? null : Number(data.cijenaDo)
    const sortiraj = String(data.sortiraj ?? 'najjeftinije').trim().toLowerCase()
    const maxResults = Number(data.maxResults ?? 10)

    if (!pojam) throw new Error('Nije zadan pojam za pretragu')
    if (cijenaOd != null && !Number.isFinite(cijenaOd)) throw new Error(`Neispravna cijenaOd: ${data.cijenaOd}`)
    if (cijenaDo != null && !Number.isFinite(cijenaDo)) throw new Error(`Neispravna cijenaDo: ${data.cijenaDo}`)
    if (cijenaOd != null && cijenaDo != null && cijenaOd > cijenaDo) {
      throw new Error(`cijenaOd (${cijenaOd}) je veća od cijenaDo (${cijenaDo})`)
    }
    if (!Number.isFinite(maxResults) || maxResults < 1) throw new Error(`Neispravan maxResults: ${data.maxResults}`)
    if (!SORT_LABELS[sortiraj]) {
      throw new Error(`Nepoznat sortiraj "${sortiraj}". Dostupno: ${Object.keys(SORT_LABELS).join(', ')}`)
    }

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Pretraga Njuškala: "${pojam}" | sort: ${sortiraj}`)

    browser = await chromium.launch({ headless: false, slowMo: 150 })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'hr-HR',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()

    eywa.info(`Otvaram ${HOME}`)
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(1500)

    await prihvatiKolacice(page)
    await upisiPojam(page, pojam)
    const filterPrimijenjen = await postaviCijenu(page, cijenaOd, cijenaDo)
    await postaviSort(page, sortiraj)

    await page.screenshot({ path: 'njuskalo_rezultati.png' })
    const finalUrl = page.url()

    const oglasi = await pokupiOglase(page, maxResults)

    await browser.close()
    browser = null

    if (!oglasi.length) {
      eywa.warn('Nema rezultata — provjeri njuskalo_rezultati.png')
      eywa.report(`Njuškalo: "${pojam}" — nema rezultata`, { pojam, url: finalUrl, ukupno: 0 })
      eywa.close_task(eywa.SUCCESS)
      return
    }

    const cijene = oglasi.map(o => parsePrice(o.cijena)).filter(c => c != null)
    const bezCijene = oglasi.length - cijene.length
    if (bezCijene) eywa.info(`${bezCijene} oglasa bez iskazane cijene`)

    eywa.report(
      `Njuškalo: "${pojam}" (${oglasi.length} oglasa)`,
      {
        pojam,
        sortirano: SORT_LABELS[sortiraj],
        filter_cijene: cijenaOd == null && cijenaDo == null
          ? 'bez filtera'
          : filterPrimijenjen
            ? `${cijenaOd ?? '—'} - ${cijenaDo ?? '—'} €`
            : `traženo ${cijenaOd ?? '—'} - ${cijenaDo ?? '—'} €, ali filter nije primijenjen`,
        url: finalUrl,
        ukupno: oglasi.length,
        bez_cijene: bezCijene,
        min_cijena: cijene.length ? `${Math.min(...cijene)} €` : null,
        max_cijena: cijene.length ? `${Math.max(...cijene)} €` : null,
        oglasi,
      }
    )

    eywa.info(`Gotovo. ${oglasi.length} oglasa${cijene.length ? `, cijene ${Math.min(...cijene)}–${Math.max(...cijene)} €` : ''}.`)
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    if (browser) { try { await browser.close() } catch {} }
    eywa.error(`Greška: ${err.message}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
