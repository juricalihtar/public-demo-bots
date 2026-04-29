import eywa from 'eywa-client'
import { chromium } from 'playwright'

const URL = 'https://www.posta.hr/izracun-cijene-slanja-posiljke'

// Mapiranje vrste pošiljke na: naziv tilea, id selecta za težinu, id ostalih selecta
const VRSTE_UNUTARNJI = {
  pismo:        { tile: 'Pismo',              tezina: 'tezinapismou' },
  paket:        { tile: 'Paket',              tezina: 'tezinapaketu',  extras: [{ id: 'izborpaketa',   label: 'Preuzimanje' }] },
  paket24:      { tile: 'Paket24',            tezina: 'tezinapaketu1', extras: [{ id: 'ppupu',         label: 'Preuzimanje' }, { id: 'rokuruc', label: 'Rok uručenja' }] },
  paket24box:   { tile: 'Paket24 box',        tezina: 'vrstapaketa',   extras: [{ id: 'izborpaketomat', label: 'Smjer' }] },
  dopisnica:    { tile: 'Dopisnica',          tezina: 'tezinadopisu' },
  prioritetno:  { tile: 'Prioritetno pismo',  tezina: 'tezinapismoup' },
  preporucena:  { tile: 'Preporučena pošiljka', tezina: 'tezinaprep' },
  vrijednosno:  { tile: 'Vrijednosno pismo',  tezina: 'tezinavrijedu' },
  tiskanica:    { tile: 'Tiskanica',           tezina: 'tezinatisaku' },
}

const VRSTE_MEDJUNARODNI = {
  dopisnica:    { tile: 'Dopisnica',    tezina: 'tezinadopisu' },
  prioritetno:  { tile: 'Pismo',        tezina: 'tezinapismoup' },
  preporucena:  { tile: 'Preporučena',  tezina: 'tezinaprep' },
  vrijednosno:  { tile: 'Vrijednosno',  tezina: 'tezinavrijedu' },
  tiskanica:    { tile: 'Tiskanica',    tezina: 'tezinatisaku' },
}

async function prihvatiKolacice(page) {
  // Čekamo malo da se banner pojavi, pa ga prihvatimo
  for (let i = 0; i < 3; i++) {
    try {
      const btn = page.locator('button', { hasText: /prihvaćam sve/i })
      await btn.waitFor({ state: 'visible', timeout: 3000 })
      await btn.click()
      eywa.info('Kolačići prihvaćeni')
      await page.waitForTimeout(600)
      return
    } catch {
      await page.waitForTimeout(1000)
    }
  }
  eywa.info('Nema cookie dialoga')
}

async function odaberiSelectPoTekstu(page, selectId, targetText) {
  const sel = page.locator(`#${selectId}`)
  const options = await sel.locator('option').all()
  for (const opt of options) {
    const text = (await opt.textContent()).trim()
    if (text === String(targetText) || text.toLowerCase().includes(String(targetText).toLowerCase())) {
      const value = await opt.getAttribute('value')
      await sel.selectOption(value)
      eywa.info(`Odabrano "${text}" za #${selectId}`)
      return text
    }
  }
  // Ako nije pronađeno, odaberi prvu nepraznu opciju
  const opts = await sel.locator('option').all()
  for (const opt of opts) {
    const val = await opt.getAttribute('value')
    if (val && val !== '') {
      const text = (await opt.textContent()).trim()
      await sel.selectOption(val)
      eywa.warn(`Tražena vrijednost "${targetText}" nije pronađena za #${selectId}, odabrano: "${text}"`)
      return text
    }
  }
  return null
}

async function dohvatiOpcije(page, selectId) {
  return await page.evaluate((id) => {
    const sel = document.querySelector(`#${id}`)
    if (!sel) return []
    return Array.from(sel.options)
      .filter(o => o.value !== '')
      .map(o => o.text.trim())
  }, selectId)
}

async function izracunajCijenu(page, vrstaKonfig, tezina, odrediste, preuzimanje) {
  // Odaberi eventualne extras (preuzimanje, smjer, rok)
  if (vrstaKonfig.extras) {
    for (const extra of vrstaKonfig.extras) {
      const vrijednost = extra.id === 'izborpaketa' || extra.id === 'ppupu' ? preuzimanje : null
      if (vrijednost) {
        await odaberiSelectPoTekstu(page, extra.id, vrijednost)
      }
    }
  }

  // Odaberi težinu / veličinu
  const tezidSelectId = vrstaKonfig.tezina
  const odabranaOpcija = await odaberiSelectPoTekstu(page, tezidSelectId, tezina)

  // Odaberi odredište za međunarodni promet
  if (odrediste) {
    await odaberiSelectPoTekstu(page, 'odrediste', odrediste)
  }

  // Screenshot prije izračuna
  await page.screenshot({ path: 'posta_before_calc.png' })

  // Klikni "Izračunaj" - klikni onaj koji je vidljiv u aktivnom panelu
  const gumbi = page.locator('button.jaf-btn, button.simple-btn').filter({ hasText: /izračunaj/i })
  const count = await gumbi.count()
  eywa.info(`Pronađeno ${count} "Izračunaj" gumba`)

  // Klikni prvi vidljivi
  for (let i = 0; i < count; i++) {
    const btn = gumbi.nth(i)
    if (await btn.isVisible()) {
      await btn.click()
      eywa.info(`Kliknuto na Izračunaj (gumb ${i + 1})`)
      break
    }
  }

  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'posta_result.png' })

  // Dohvati rezultat - cijena se obično prikazuje u nekom elementu s klasom rezultata
  const cijena = await page.evaluate(() => {
    // Pokušaj različite selektore koji se koriste za prikaz cijene
    const selektori = [
      '.jaf-result', '.result-price', '.price-result', '.cijena',
      '[class*="result"]', '[class*="price"]', '[class*="iznos"]',
      '.jaf-output', '.calculator-result',
    ]
    for (const sel of selektori) {
      const el = document.querySelector(sel)
      if (el && el.textContent.trim()) return el.textContent.trim()
    }
    // Fallback: traži text koji sadrži "EUR" ili "kn" ili broj s decimalama
    const sviElemeti = document.querySelectorAll('span, div, p, strong, b')
    for (const el of sviElemeti) {
      const tekst = el.textContent.trim()
      if (/\d+[,\.]\d+\s*(EUR|€)/.test(tekst) && tekst.length < 100) {
        return tekst
      }
    }
    return null
  })

  return { odabranaOpcija, cijena }
}

async function main() {
  eywa.open_pipe()

  let browser = null
  try {
    const task = await eywa.get_task()
    eywa.info(`Task: ${JSON.stringify(task)}`)

    const data = task?.data || {}
    const promet       = String(data.promet       ?? 'unutarnji').toLowerCase()  // unutarnji | medjunarodni
    const vrstaPosiljke = String(data.vrstaPosiljke ?? 'pismo').toLowerCase()     // pismo | paket | paket24 | ...
    const tezina       = String(data.tezina        ?? 'do 50')                    // label iz dropdowna
    const odrediste    = String(data.odrediste     ?? '')                          // samo za međunarodni
    const preuzimanje  = String(data.preuzimanje   ?? '')                          // za paket/paket24

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Promet: ${promet} | Vrsta: ${vrstaPosiljke} | Težina: ${tezina}`)

    const vrsteKonfig = promet === 'medjunarodni' ? VRSTE_MEDJUNARODNI : VRSTE_UNUTARNJI
    const vrstaKonfig = vrsteKonfig[vrstaPosiljke]

    if (!vrstaKonfig) {
      const dostupne = Object.keys(vrsteKonfig).join(', ')
      throw new Error(`Nepoznata vrsta pošiljke "${vrstaPosiljke}". Dostupne: ${dostupne}`)
    }

    browser = await chromium.launch({ headless: false, slowMo: 300 })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'hr-HR',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()

    eywa.info('Otvaranje posta.hr kalkulatora...')
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(1500)

    await prihvatiKolacice(page)

    // Odaberi tab "Unutarnji promet" ili "Međunarodni promet"
    if (promet === 'medjunarodni') {
      eywa.info('Klikam na "Međunarodni promet"')
      await page.locator('a, button, [role="tab"]').filter({ hasText: /međunarodni promet/i }).first().click()
      await page.waitForTimeout(1000)
    } else {
      eywa.info('Unutarnji promet je defaultno odabran')
    }

    // Klikni na tile s vrstom pošiljke - traži element koji sadrži tekst u navigaciji
    eywa.info(`Klikam na tile "${vrstaKonfig.tile}"`)
    const tileLocator = page.locator('figure, li, [class*="item"], [class*="service-type"], a')
      .filter({ hasText: new RegExp(`^${vrstaKonfig.tile}$`, 'i') })
      .first()

    try {
      await tileLocator.click({ timeout: 4000 })
      eywa.info(`Kliknuto na tile "${vrstaKonfig.tile}"`)
    } catch {
      // Fallback: klikni na paragraf/span s točnim tekstom unutar interaktivnog elementa
      eywa.info(`Koristim fallback za tile "${vrstaKonfig.tile}"`)
      await page.locator(`text=/^${vrstaKonfig.tile}$/i`).first().click()
    }
    await page.waitForTimeout(1000)

    // Dohvati sve dostupne opcije za informaciju
    const opcijeTezine = await dohvatiOpcije(page, vrstaKonfig.tezina)
    eywa.info(`Dostupne opcije težine: ${opcijeTezine.join(', ')}`)

    const { odabranaOpcija, cijena } = await izracunajCijenu(page, vrstaKonfig, tezina, odrediste || null, preuzimanje || null)

    await browser.close()
    browser = null

    const rezultat = {
      promet,
      vrstaPosiljke,
      tile: vrstaKonfig.tile,
      tezina: odabranaOpcija,
      odrediste: odrediste || 'Hrvatska',
      cijena: cijena || 'Nije pronađena - provjeri screenshot posta_result.png',
    }

    eywa.info(`Rezultat: ${JSON.stringify(rezultat)}`)

    eywa.report(
      `Cijena slanja: ${vrstaKonfig.tile} (${promet})`,
      {
        vrsta: vrstaKonfig.tile,
        promet,
        tezina: odabranaOpcija,
        odrediste: odrediste || 'Hrvatska',
        cijena,
        napomena: cijena ? null : 'Cijena nije dohvaćena automatski. Provjeri screenshot posta_result.png',
      }
    )

    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    if (browser) { try { await browser.close() } catch {} }
    eywa.error(`Greška: ${err.message}\n${err.stack}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
