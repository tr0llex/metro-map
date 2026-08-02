/**
 * Поиск координат станции в OpenStreetMap через Nominatim.
 *
 * Живёт отдельно от хука: это единственное место в редакторе, которое ходит в
 * сеть, и единственное, которому для проверки нужен поддельный `fetch`.
 */

/**
 * Запрос был «станция метро {название}, Москва» и не находил НИЧЕГО.
 * В OSM объект называется просто «Боровицкая»; слов «станция метро» в имени
 * нет, а свободный поиск Nominatim не разбирает их как категорию — он честно
 * ищет эту фразу целиком. Ломалось для любой станции, в чьём названии нет
 * слова «метро», то есть практически для всех.
 *
 * Ищем по имени, а принадлежность к метро проверяем по классу объекта в
 * ответе. Берём пять кандидатов, а не один: по названию станции первой может
 * прийти одноимённая улица или площадь.
 */
export async function fetchStationGeoFromOSM(title: string): Promise<{ lat: number; lon: number }> {
  const query = `${title}, Москва`
  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=5&countrycodes=ru&accept-language=ru&q=${encodeURIComponent(query)}`

  const resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })

  if (resp.status === 429 || resp.status === 403) {
    // Nominatim ограничивает до одного запроса в секунду. Без этой ветки
    // отказ выглядел как «координаты не найдены», и станцию искали в OSM
    // руками, хотя она там есть.
    throw new Error('OSM: слишком часто, подожди секунду и повтори')
  }

  if (!resp.ok) {
    throw new Error(`OSM API error: ${resp.status}`)
  }

  const data = (await resp.json()) as Array<{
    lat?: string
    lon?: string
    category?: string
    class?: string
    type?: string
  }>

  const isRailway = (item: (typeof data)[number]) =>
    item.category === 'railway' || item.class === 'railway'

  const first = data.find(isRailway) ?? data[0]
  const lat = first?.lat != null ? Number(first.lat) : NaN
  const lon = first?.lon != null ? Number(first.lon) : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('OSM: координаты не найдены')
  }

  return { lat, lon }
}
