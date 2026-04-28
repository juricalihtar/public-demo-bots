import eywa from 'eywa-client'

const CURRENCY_SYMBOL = { eur: '€', usd: '$', gbp: '£', chf: 'Fr' }

function formatNumber(n, decimals = 2) {
  if (n === null || n === undefined) return 'N/A'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return n.toFixed(decimals)
}

function formatChange(pct) {
  if (pct === null || pct === undefined) return 'N/A'
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

async function fetchPrices(coinIds, currency) {
  const ids = coinIds.join(',')
  const url = [
    'https://api.coingecko.com/api/v3/simple/price',
    `?ids=${encodeURIComponent(ids)}`,
    `&vs_currencies=${currency}`,
    `&include_24hr_change=true`,
    `&include_market_cap=true`,
    `&include_24hr_vol=true`,
  ].join('')

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  })

  if (res.status === 429) throw new Error('CoinGecko rate limit — pokušaj za nekoliko sekundi')
  if (!res.ok) throw new Error(`CoinGecko API greška: ${res.status}`)

  return res.json()
}

async function fetchCoinNames(coinIds) {
  // Dohvati puna imena i simbole za coinove
  const url = 'https://api.coingecko.com/api/v3/coins/list'
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if (!res.ok) return {}
  const list = await res.json()
  const map = {}
  for (const coin of list) {
    if (coinIds.includes(coin.id)) {
      map[coin.id] = { name: coin.name, symbol: coin.symbol.toUpperCase() }
    }
  }
  return map
}

async function main() {
  eywa.open_pipe()

  try {
    const task = await eywa.get_task()
    const data = task?.data || {}

    const coinsRaw = String(data.coins ?? 'bitcoin,ethereum,solana')
    const currency = String(data.currency ?? 'eur').toLowerCase()
    const coinIds  = coinsRaw.split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
    const symbol   = CURRENCY_SYMBOL[currency] ?? currency.toUpperCase()

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Dohvaćam cijene za: ${coinIds.join(', ')} u ${currency.toUpperCase()}`)

    // Paralelno dohvati cijene i imena
    const [prices, names] = await Promise.all([
      fetchPrices(coinIds, currency),
      fetchCoinNames(coinIds),
    ])

    const missing = coinIds.filter(id => !prices[id])
    if (missing.length) eywa.warn(`Nije pronađeno: ${missing.join(', ')} — provjeri ID-ove`)

    const rows = coinIds
      .filter(id => prices[id])
      .map(id => {
        const p = prices[id]
        const meta = names[id] || { name: id, symbol: id.toUpperCase() }
        const change = p[`${currency}_24h_change`]
        return {
          Kriptovaluta: meta.name,
          Simbol: meta.symbol,
          [`Cijena (${symbol})`]: formatNumber(p[currency], p[currency] < 1 ? 6 : 2),
          '24h promjena': formatChange(change),
          [`Tržišna kap. (${symbol})`]: formatNumber(p[`${currency}_market_cap`]),
          [`Vol. 24h (${symbol})`]: formatNumber(p[`${currency}_24h_vol`]),
          Trend: change >= 0 ? 'rast' : 'pad',
        }
      })

    // Sortiraj po tržišnoj kapitalizaciji
    rows.sort((a, b) => {
      const capA = prices[coinIds.find(id => names[id]?.name === a.Kriptovaluta)]?.[`${currency}_market_cap`] || 0
      const capB = prices[coinIds.find(id => names[id]?.name === b.Kriptovaluta)]?.[`${currency}_market_cap`] || 0
      return capB - capA
    })

    const rising  = rows.filter(r => r.Trend === 'rast').length
    const falling = rows.filter(r => r.Trend === 'pad').length

    eywa.report(
      `Crypto cijene — ${new Date().toISOString().slice(0, 10)}`,
      {
        valuta: currency.toUpperCase(),
        praceno_coinova: rows.length,
        u_rastu: rising,
        u_padu: falling,
        cijene: rows,
      }
    )

    eywa.info(`Gotovo. ${rows.length} coinova: ${rising} u rastu, ${falling} u padu.`)
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    eywa.error(`Greška: ${err.message}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
