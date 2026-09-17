import eywa from 'eywa-client'
import { gunzipSync } from 'node:zlib'

// Otvoreni dataset minGO-a (Ministarstvo gospodarstva) — sve postaje i cjenici u RH.
const DATA_URL = 'https://mzoe-gor.hr/data.gz'

function formatPrice(n) {
  return Number.isFinite(n) ? n.toFixed(2) : 'N/A'
}

// Uklanja dijakritiku da "Sibenik" pronađe "Šibenik"
function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim()
}

async function fetchDataset() {
  const res = await fetch(DATA_URL, { headers: { 'Accept': 'application/octet-stream' } })
  if (!res.ok) throw new Error(`minGO greška: ${res.status}`)

  // Servira se kao .gz datoteka bez Content-Encoding zaglavlja — raspakiraj ručno
  const buf = Buffer.from(await res.arrayBuffer())
  return JSON.parse(gunzipSync(buf).toString('utf8'))
}

function main_filter(dataset, gorivoQuery) {
  const q = normalize(gorivoQuery)

  // Traži prvo po vrsti goriva (Eurosuper 95, Eurodizel...), pa po tipu (Benzinska goriva, Autoplin...)
  const vrste = dataset.vrsta_gorivas.filter(v => normalize(v.vrsta_goriva).includes(q))
  const tipovi = dataset.tip_gorivas.filter(t => normalize(t.tip_goriva).includes(q))

  if (!vrste.length && !tipovi.length) return null

  const vrstaIds = new Set(vrste.map(v => v.id))
  for (const t of tipovi) {
    for (const v of dataset.vrsta_gorivas) {
      if (v.tip_goriva_id === t.id) vrstaIds.add(v.id)
    }
  }

  // gorivo_id (proizvod pojedine tvrtke) -> pripada li traženoj vrsti
  const gorivoIds = new Set(
    dataset.gorivos.filter(g => vrstaIds.has(g.vrsta_goriva_id)).map(g => g.id)
  )

  const label = vrste.length
    ? [...new Set(vrste.map(v => v.vrsta_goriva))].join(', ')
    : tipovi.map(t => t.tip_goriva).join(', ')

  return { gorivoIds, label }
}

async function main() {
  eywa.open_pipe()

  try {
    const task = await eywa.get_task()
    const data = task?.data || {}

    const gorivo = String(data.gorivo ?? 'Eurodizel').trim()
    const mjesto = String(data.mjesto ?? '').trim()
    const maxResults = Number(data.maxResults ?? 10)

    if (!gorivo) throw new Error('Nije zadana vrsta goriva')
    if (!Number.isFinite(maxResults) || maxResults < 1) {
      throw new Error(`Neispravan maxResults: ${data.maxResults}`)
    }

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Dohvaćam minGO dataset za "${gorivo}"${mjesto ? ` — ${mjesto}` : ' — cijela RH'}`)

    const dataset = await fetchDataset()

    const filter = main_filter(dataset, gorivo)
    if (!filter) {
      const dostupne = dataset.vrsta_gorivas.map(v => v.vrsta_goriva).join(', ')
      throw new Error(`Nepoznata vrsta goriva "${gorivo}". Dostupno: ${dostupne}`)
    }

    const tvrtke = new Map(dataset.obvezniks.map(o => [o.id, o.naziv]))
    const gorivaById = new Map(dataset.gorivos.map(g => [g.id, g.naziv]))
    const mjestoQuery = normalize(mjesto)

    const rows = []
    for (const p of dataset.postajas) {
      // Traži samo po mjestu — adresa bi npr. za "Zagreb" uhvatila i
      // "Zagrebačka 13, Bregana"
      if (mjestoQuery && !normalize(p.mjesto).includes(mjestoQuery)) continue

      // Najjeftiniji proizvod tražene vrste na toj postaji
      let best = null
      for (const c of p.cjenici ?? []) {
        if (!filter.gorivoIds.has(c.gorivo_id)) continue
        const cijena = Number(c.cijena)
        if (!Number.isFinite(cijena) || cijena <= 0) continue
        if (!best || cijena < best.cijena) best = { cijena, gorivo_id: c.gorivo_id }
      }
      if (!best) continue

      rows.push({
        Cijena: `${formatPrice(best.cijena)} €`,
        Postaja: p.naziv,
        Tvrtka: tvrtke.get(p.obveznik_id) ?? 'nepoznato',
        Mjesto: p.mjesto,
        Adresa: p.adresa,
        Proizvod: gorivaById.get(best.gorivo_id) ?? 'nepoznato',
        _cijena: best.cijena,
      })
    }

    if (!rows.length) {
      throw new Error(mjesto
        ? `Nema postaja s gorivom "${gorivo}" za lokaciju "${mjesto}"`
        : `Nema postaja s gorivom "${gorivo}"`)
    }

    rows.sort((a, b) => a._cijena - b._cijena)

    // U službenom datasetu ima krivo unesenih cijena (npr. dizel po 13 €/l).
    // Fiksni prag ne bi radio jer plinske boce legitimno koštaju i preko 500 €,
    // pa se ograda računa iz same distribucije. Kod reguliranih goriva je
    // IQR često 0 (sve postaje imaju istu cijenu) i sama bi IQR ograda bacila
    // svako legitimno odstupanje, pa se uzima šira od dvije ograde.
    const cijenaAt = q => rows[Math.floor((rows.length - 1) * q)]._cijena
    const medijan = cijenaAt(0.5)
    const q1 = cijenaAt(0.25)
    const q3 = cijenaAt(0.75)
    const iqr = q3 - q1
    const gornja = Math.max(q3 + 3 * iqr, medijan * 2.5)
    const donja = Math.min(q1 - 3 * iqr, medijan / 2.5)

    const valid = rows.filter(r => r._cijena <= gornja && r._cijena >= donja)
    const suspicious = rows.length - valid.length

    if (suspicious) {
      eywa.warn(
        `Izostavljeno ${suspicious} postaja s neuvjerljivom cijenom ` +
        `(medijan ${formatPrice(medijan)} €, prihvaćeno ${formatPrice(donja)}–${formatPrice(gornja)} €)`
      )
    }
    if (!valid.length) throw new Error('Sve pronađene cijene izgledaju neispravno')

    const cijene = valid.map(r => r._cijena)
    const prosjek = cijene.reduce((sum, c) => sum + c, 0) / cijene.length
    const najjeftinija = valid[0]
    const najskuplja = valid[valid.length - 1]

    const top = valid.slice(0, maxResults).map(({ _cijena, ...rest }) => rest)

    eywa.report(
      `Cijene goriva — ${filter.label}${mjesto ? ` (${mjesto})` : ''}`,
      {
        gorivo: filter.label,
        lokacija: mjesto || 'cijela Hrvatska',
        pronadeno_postaja: valid.length,
        prikazano: top.length,
        najniza_cijena: `${formatPrice(najjeftinija._cijena)} €`,
        najvisa_cijena: `${formatPrice(najskuplja._cijena)} €`,
        prosjecna_cijena: `${formatPrice(prosjek)} €`,
        razlika: `${formatPrice(najskuplja._cijena - najjeftinija._cijena)} €`,
        najjeftinije: top,
      }
    )

    eywa.info(
      `Gotovo. ${valid.length} postaja, najjeftinije ${formatPrice(najjeftinija._cijena)} € ` +
      `(${najjeftinija.Postaja}, ${najjeftinija.Mjesto}), prosjek ${formatPrice(prosjek)} €.`
    )
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    eywa.error(`Greška: ${err.message}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
