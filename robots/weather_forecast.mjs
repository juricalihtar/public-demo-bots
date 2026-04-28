import eywa from 'eywa-client'

const WMO_CODES = {
  0: 'Vedro', 1: 'Pretežno vedro', 2: 'Djelomično oblačno', 3: 'Oblačno',
  45: 'Magla', 48: 'Magla s mrazom',
  51: 'Slaba rosulja', 53: 'Rosulja', 55: 'Jaka rosulja',
  61: 'Slaba kiša', 63: 'Kiša', 65: 'Jaka kiša',
  71: 'Slab snijeg', 73: 'Snijeg', 75: 'Jak snijeg',
  77: 'Zrnati snijeg',
  80: 'Pljuskovi', 81: 'Jaki pljuskovi', 82: 'Olujni pljuskovi',
  85: 'Snježni pljuskovi', 86: 'Jaki snježni pljuskovi',
  95: 'Grmljavinska oluja', 96: 'Oluja s gradom', 99: 'Jaka oluja s gradom',
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=hr`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding greška: ${res.status}`)
  const data = await res.json()
  if (!data.results?.length) throw new Error(`Grad "${city}" nije pronađen`)
  const { latitude, longitude, name, country } = data.results[0]
  return { latitude, longitude, name, country }
}

async function fetchForecast(latitude, longitude, days, units) {
  const tempUnit = units === 'fahrenheit' ? 'fahrenheit' : 'celsius'
  const url = [
    'https://api.open-meteo.com/v1/forecast',
    `?latitude=${latitude}&longitude=${longitude}`,
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max`,
    `&forecast_days=${Math.min(Math.max(days, 1), 16)}`,
    `&temperature_unit=${tempUnit}`,
    `&timezone=auto`,
  ].join('')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Forecast API greška: ${res.status}`)
  return res.json()
}

async function main() {
  eywa.open_pipe()

  try {
    const task = await eywa.get_task()
    const data = task?.data || {}
    const city    = String(data.city  ?? 'Zagreb')
    const days    = Number(data.days  ?? 7)
    const units   = String(data.units ?? 'celsius')
    const symbol  = units === 'fahrenheit' ? '°F' : '°C'

    eywa.update_task(eywa.PROCESSING)
    eywa.info(`Tražim koordinate za: ${city}`)

    const location = await geocode(city)
    eywa.info(`Pronađeno: ${location.name}, ${location.country} (${location.latitude}, ${location.longitude})`)

    eywa.info(`Dohvaćam prognozu za ${days} dana...`)
    const forecast = await fetchForecast(location.latitude, location.longitude, days, units)

    const { time, temperature_2m_max, temperature_2m_min, precipitation_sum, weathercode, windspeed_10m_max } = forecast.daily

    const rows = time.map((date, i) => ({
      Datum: date,
      Opis: WMO_CODES[weathercode[i]] ?? `Kod ${weathercode[i]}`,
      [`Max (${symbol})`]: temperature_2m_max[i],
      [`Min (${symbol})`]: temperature_2m_min[i],
      'Padaline (mm)': precipitation_sum[i] ?? 0,
      'Vjetar (km/h)': windspeed_10m_max[i],
    }))

    const avgMax = (temperature_2m_max.reduce((a, b) => a + b, 0) / temperature_2m_max.length).toFixed(1)
    const avgMin = (temperature_2m_min.reduce((a, b) => a + b, 0) / temperature_2m_min.length).toFixed(1)
    const totalRain = precipitation_sum.reduce((a, b) => a + (b ?? 0), 0).toFixed(1)

    eywa.report(
      `Prognoza: ${location.name} — ${days} dana`,
      {
        lokacija: `${location.name}, ${location.country}`,
        koordinate: `${location.latitude}, ${location.longitude}`,
        period: `${time[0]} → ${time[time.length - 1]}`,
        prosjek_max: `${avgMax}${symbol}`,
        prosjek_min: `${avgMin}${symbol}`,
        ukupne_padaline: `${totalRain} mm`,
        prognoza: rows,
      }
    )

    eywa.info(`Gotovo. Prosječna max temp: ${avgMax}${symbol}, ukupne padaline: ${totalRain}mm`)
    eywa.close_task(eywa.SUCCESS)

  } catch (err) {
    eywa.error(`Greška: ${err.message}`)
    eywa.close_task(eywa.ERROR)
  }
}

main()
