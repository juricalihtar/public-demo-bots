import eywa from 'eywa-client'

const API = 'https://api.hnb.hr/tecajn-eur/v3'

// HNB vraća brojeve s zarezom kao decimalnim separatorom ("1,153700")
function parseHnbNumber(s) {
  return parseFloat(String(s).replace(',', '.'))
}

function formatNumber(n, decimals = 4) {
  if (!Number.isFinite(n)) return 'N/A'
  return n.toFixed(decimals)
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
}

async function fetchRates(currencies, datum) {
  const params = currencies.map(v => `valuta=${encodeURIComponent(v)}`)
  if (datum) params.push(`datum-primjene=${datum}`)
  const url = `${API}?${params.join('&')}`

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if (!res.ok) {
    // HNB vraća 400 s porukom u plain textu, npr. "Unsupported currency code XXX"
    const detail = (await res.text().catch(() => '')).trim()
    throw new Error(`HNB API greška ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  return res.json()
}

async function main() {
  eywa.open_pipe()

  try {
    const task = await eywa.get_task()
    const data = task?.data || {}

    const valuteRaw = String(data.valute ?? 'USD,GBP,CHF')
    const valute = valuteRaw.split(',').map(v => v.trim().toUpperCase()).filter(Boolean)
    const iznos = Number(data.iznos ?? 100)
    const datum = String(data.datum ?? '').trim()

    if (!valute.length) throw new Error('Nije zadana nijedna valuta')
    if (!Number.isFinite(iznos)) throw new Error(`Neispravan iznos: ${data.iznos}`)
    if (datum && !isValidDate(datum)) throw new Error(`Neispravan datum: "${datum}" — očekujem YYYY-MM-DD`)

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Dohvaćam HNB tečaj za: ${valute.join(', ')}${datum ? ` na dan ${datum}` : ''}`)

    const tecajnica = await fetchRates(valute, datum || null)

    if (!tecajnica.length) {
      throw new Error(datum
        ? `HNB nema tečajnicu za ${datum} (vikend ili praznik?)`
        : 'HNB nije vratio nijedan tečaj')
    }

    const vraceno = tecajnica.map(t => t.valuta)
    const missing = valute.filter(v => !vraceno.includes(v))
    if (missing.length) eywa.warn(`Nije pronađeno: ${missing.join(', ')} — provjeri oznake valuta`)

    const rows = tecajnica.map(t => {
      const srednji = parseHnbNumber(t.srednji_tecaj)
      return {
        Valuta: t.valuta,
        Država: t.drzava,
        'Kupovni': formatNumber(parseHnbNumber(t.kupovni_tecaj), 6),
        'Srednji': formatNumber(srednji, 6),
        'Prodajni': formatNumber(parseHnbNumber(t.prodajni_tecaj), 6),
        [`${iznos} EUR =`]: `${formatNumber(iznos * srednji, 2)} ${t.valuta}`,
        [`${iznos} ${t.valuta} =`]: `${formatNumber(iznos / srednji, 2)} EUR`,
      }
    })

    rows.sort((a, b) => a.Valuta.localeCompare(b.Valuta))

    const datumPrimjene = tecajnica[0].datum_primjene
    const brojTecajnice = tecajnica[0].broj_tecajnice

    eywa.report(
      `HNB tečajna lista br. ${brojTecajnice} — ${datumPrimjene}`,
      {
        datum_primjene: datumPrimjene,
        broj_tecajnice: brojTecajnice,
        osnovna_valuta: 'EUR',
        iznos_za_konverziju: iznos,
        broj_valuta: rows.length,
        tecajevi: rows,
      }
    )

    eywa.info(`Gotovo. Dohvaćeno ${rows.length} tečaja (tečajnica br. ${brojTecajnice} od ${datumPrimjene}).`)
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    eywa.error(`Greška: ${err.message}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
