import { describe, expect, it } from 'vitest'

import { applyEditorPatch, type DataFiles } from './applyEditorPatch.ts'

function base(): DataFiles {
  return {
    lines: {
      '001-a.json': {
        id: 1,
        title: 'Первая',
        color: '#E42313',
        ring: false,
        stations: [
          { id: '1/a', title: 'А', lat: 55.1, lon: 37.1, toNextSeconds: 120 },
          { id: '1/b', title: 'Б', toNextSeconds: 150 },
          { id: '1/c', title: 'В' },
        ],
      },
      '004-branch.json': {
        id: 4,
        title: 'С веткой',
        color: '#1EBCEF',
        ring: false,
        stations: [
          { id: '4/m1', title: 'М1', toNextSeconds: 100 },
          { id: '4/m2', title: 'М2' },
        ],
        branches: [
          {
            title: 'Ветка',
            from: '4/m1',
            fromSeconds: 180,
            stations: [{ id: '4/b1', title: 'Б1' }],
          },
        ],
      },
      '005-ring.json': {
        id: 5,
        title: 'Кольцо',
        color: '#915133',
        ring: true,
        stations: [
          { id: '5/x', title: 'Икс', toNextSeconds: 200 },
          { id: '5/y', title: 'Игрек', toNextSeconds: 210 },
          { id: '5/z', title: 'Зет', toNextSeconds: 220 },
        ],
      },
    },
    transfers: {
      defaults: {
        rideSeconds: 150,
        hubMinSeconds: 240,
        kindSeconds: { near: 180, far: 300, mcc: 300, out_of_station: 480 },
      },
      transfers: [{ stations: ['1/a', '5/x'], kind: 'near' }],
    },
    layout: {
      stations: {
        '1/a': [0, 0],
        '1/b': [10, 0],
        '1/c': [20, 0],
        '4/b1': [0, 40],
        '4/m1': [0, 20],
        '4/m2': [10, 20],
        '5/x': [0, 60],
        '5/y': [10, 60],
        '5/z': [20, 60],
      },
      rings: {},
    },
  }
}

const allIds = Object.keys(base().layout.stations)
const fullLayout = (over: Record<string, [number, number]> = {}) => {
  const l = base().layout.stations
  return { ...l, ...over }
}

describe('станции: название и география', () => {
  it('переименование меняет файл линии и попадает в отчёт', () => {
    const { files, changes, changedFiles } = applyEditorPatch(base(), {
      stations: { '1/a': { title: 'Новая А' } },
    })
    expect(files.lines['001-a.json'].stations[0].title).toBe('Новая А')
    expect(changes.join()).toContain('«А» -> «Новая А»')
    expect(changedFiles).toEqual(['data/lines/001-a.json'])
  })

  it('станция ветки правится так же, как станция основного хода', () => {
    const { files } = applyEditorPatch(base(), { stations: { '4/b1': { title: 'Новая' } } })
    expect(files.lines['004-branch.json'].branches![0].stations[0].title).toBe('Новая')
  })

  it('название обрезается по краям, но пустым быть не может', () => {
    const { files } = applyEditorPatch(base(), { stations: { '1/a': { title: '  Ок  ' } } })
    expect(files.lines['001-a.json'].stations[0].title).toBe('Ок')
    expect(() => applyEditorPatch(base(), { stations: { '1/a': { title: '   ' } } })).toThrow(
      /пустое название/,
    )
  })

  it('координаты географии проверяются на конечность', () => {
    expect(() =>
      applyEditorPatch(base(), { stations: { '1/a': { lat: Number.NaN } } }),
    ).toThrow(/lat/)
  })

  it('неизвестная станция — ошибка, а не молчаливый пропуск', () => {
    expect(() => applyEditorPatch(base(), { stations: { '9/nope': { title: 'X' } } })).toThrow(
      /нет ни в одном файле/,
    )
  })

  it('правка, совпадающая с текущим значением, файл не меняет', () => {
    const { changedFiles } = applyEditorPatch(base(), { stations: { '1/a': { title: 'А' } } })
    expect(changedFiles).toEqual([])
  })
})

describe('времена перегонов', () => {
  it('время пишется станции, ОТ которой идёт перегон', () => {
    const { files } = applyEditorPatch(base(), { rides: { '1/a>1/b': 199 } })
    expect(files.lines['001-a.json'].stations[0].toNextSeconds).toBe(199)
    expect(files.lines['001-a.json'].stations[1].toNextSeconds).toBe(150)
  })

  /** У кольцевой линии последняя станция замыкается на первую. */
  it('замыкающий перегон кольца доступен для правки', () => {
    const { files } = applyEditorPatch(base(), { rides: { '5/z>5/x': 240 } })
    expect(files.lines['005-ring.json'].stations[2].toNextSeconds).toBe(240)
  })

  it('перегон от станции отхода ветки пишется в fromSeconds', () => {
    const { files } = applyEditorPatch(base(), { rides: { '4/m1>4/b1': 90 } })
    expect(files.lines['004-branch.json'].branches![0].fromSeconds).toBe(90)
    // Основной ход не задет: у «М1» своё время до «М2».
    expect(files.lines['004-branch.json'].stations[0].toNextSeconds).toBe(100)
  })

  it('несуществующий перегон — ошибка', () => {
    expect(() => applyEditorPatch(base(), { rides: { '1/a>1/c': 100 } })).toThrow(/нет ни на одной/)
    // Направление имеет значение: в файле линия идёт A -> B.
    expect(() => applyEditorPatch(base(), { rides: { '1/b>1/a': 100 } })).toThrow(/нет ни на одной/)
  })

  it('неположительное время отвергается', () => {
    expect(() => applyEditorPatch(base(), { rides: { '1/a>1/b': 0 } })).toThrow(/время/)
    expect(() => applyEditorPatch(base(), { rides: { '1/a>1/b': -5 } })).toThrow(/время/)
  })
})

describe('пересадки', () => {
  it('добавляется с типом и попадает в отсортированный список', () => {
    const { files, changes } = applyEditorPatch(base(), {
      transfers: { upsert: [{ stations: ['5/y', '1/b'], kind: 'far' }] },
    })
    expect(files.transfers.transfers).toHaveLength(2)
    expect(files.transfers.transfers[1]).toEqual({ stations: ['1/b', '5/y'], kind: 'far' })
    expect(changes.join()).toContain('добавлена')
  })

  it('пара станций нормализуется по порядку независимо от того, как её прислали', () => {
    const a = applyEditorPatch(base(), { transfers: { upsert: [{ stations: ['5/y', '1/b'] }] } })
    const b = applyEditorPatch(base(), { transfers: { upsert: [{ stations: ['1/b', '5/y'] }] } })
    expect(a.files.transfers.transfers).toEqual(b.files.transfers.transfers)
  })

  /** Время пишем только там, где оно отличается от типового: иначе не видно исключений. */
  it('типовое время в файл не пишется, отличающееся — пишется', () => {
    const same = applyEditorPatch(base(), {
      transfers: { upsert: [{ stations: ['1/b', '5/y'], kind: 'near', seconds: 180 }] },
    })
    expect(same.files.transfers.transfers[1].seconds).toBeUndefined()

    const other = applyEditorPatch(base(), {
      transfers: { upsert: [{ stations: ['1/b', '5/y'], kind: 'near', seconds: 260 }] },
    })
    expect(other.files.transfers.transfers[1].seconds).toBe(260)
  })

  it('повторный upsert меняет существующую пересадку, а не добавляет вторую', () => {
    const { files } = applyEditorPatch(base(), {
      transfers: { upsert: [{ stations: ['1/a', '5/x'], kind: 'mcc' }] },
    })
    expect(files.transfers.transfers).toHaveLength(1)
    expect(files.transfers.transfers[0].kind).toBe('mcc')
  })

  it('удаление убирает пересадку, повторное удаление не ошибка', () => {
    const { files, changes } = applyEditorPatch(base(), {
      transfers: { remove: [['5/x', '1/a'], ['5/x', '1/a']] },
    })
    expect(files.transfers.transfers).toEqual([])
    expect(changes.filter((c) => c.includes('удалена'))).toHaveLength(1)
  })

  it('пересадка внутри одной линии отвергается', () => {
    expect(() =>
      applyEditorPatch(base(), { transfers: { upsert: [{ stations: ['1/a', '1/b'] }] } }),
    ).toThrow(/на одной линии/)
  })

  it('неизвестный тип и несуществующая станция отвергаются', () => {
    expect(() =>
      applyEditorPatch(base(), { transfers: { upsert: [{ stations: ['1/b', '5/y'], kind: 'мцд' }] } }),
    ).toThrow(/неизвестный тип/)
    expect(() =>
      applyEditorPatch(base(), { transfers: { upsert: [{ stations: ['1/b', '9/nope'] }] } }),
    ).toThrow(/нет ни на одной/)
  })
})

describe('раскладка', () => {
  it('координаты записываются отсортированными по id', () => {
    const { files } = applyEditorPatch(base(), { layout: fullLayout({ '1/a': [5, 5] }) })
    expect(files.layout.stations['1/a']).toEqual([5, 5])
    expect(Object.keys(files.layout.stations)).toEqual([...allIds].sort())
  })

  it('в отчёте видно, сколько станций сдвинулось', () => {
    const { changes } = applyEditorPatch(base(), {
      layout: fullLayout({ '1/a': [5, 5], '1/b': [7, 7] }),
    })
    expect(changes.join()).toContain('сдвинуто станций — 2')
  })

  /**
   * Неполная раскладка останавливает сохранение. Станция без координат просто
   * не нарисуется, а солвер такой файл не примет — лучше не записать вовсе,
   * чем записать заведомо ломаный.
   */
  it('неполная раскладка отвергается', () => {
    const partial = { ...fullLayout() } as Record<string, [number, number]>
    delete partial['1/c']
    expect(() => applyEditorPatch(base(), { layout: partial })).toThrow(/нет координат/)
  })

  it('координаты несуществующей станции отвергаются', () => {
    expect(() =>
      applyEditorPatch(base(), { layout: { ...fullLayout(), '9/nope': [1, 1] } }),
    ).toThrow(/несуществующей станции/)
  })

  it('нечисловые координаты отвергаются', () => {
    expect(() =>
      applyEditorPatch(base(), {
        layout: { ...fullLayout(), '1/a': [Number.NaN, 0] as [number, number] },
      }),
    ).toThrow(/\[x, y\]/)
  })
})

describe('общее поведение', () => {
  it('исходные файлы не мутируются', () => {
    const input = base()
    const snapshot = JSON.stringify(input)
    applyEditorPatch(input, {
      stations: { '1/a': { title: 'Другое' } },
      layout: fullLayout({ '1/a': [9, 9] }),
    })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('пустой патч ничего не меняет', () => {
    const { changes, changedFiles } = applyEditorPatch(base(), {})
    expect(changes).toEqual([])
    expect(changedFiles).toEqual([])
  })

  it('затронутые файлы перечисляются точно', () => {
    const { changedFiles } = applyEditorPatch(base(), {
      stations: { '4/b1': { title: 'Новая' } },
      transfers: { upsert: [{ stations: ['1/b', '5/y'] }] },
      layout: fullLayout({ '1/a': [3, 3] }),
    })
    expect(changedFiles.sort()).toEqual([
      'data/layout.json',
      'data/lines/004-branch.json',
      'data/transfers.json',
    ])
  })
})
