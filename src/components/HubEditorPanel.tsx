import { useEffect, useState } from 'react'
import { formatTravelTime } from '../editor/travelTime.ts'
import type {
  FullGraphStation,
  FullGraphLine,
  FullGraphEdge,
  EdgeOverride,
} from '../metro/types'

interface StationOverrideLite {
  title?: string
  lineNumericId?: number | null
  lat?: number
  lon?: number
}

interface HubEditorPanelProps {
  inspectedStation: FullGraphStation
  inspectedLineId: number | null
  inspectedEdges: FullGraphEdge[]
  fullGraphLines: FullGraphLine[]
  fullGraphEdges: FullGraphEdge[]
  stationOverrides: Record<string, StationOverrideLite>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  hiddenStations: Record<string, true>
  stationById: Map<string, FullGraphStation>
  lineByNumericId: Map<number, FullGraphLine>
  edgeOverrides: Record<string, EdgeOverride>
  newEdgeTarget: string
  findExactStationByName: (query: string) => FullGraphStation | null | undefined
  edgeKey: (a: string, b: string) => string
  onClose: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onChangeStationTitle: (stationId: string, newTitle: string) => void
  onChangeStationLine: (stationId: string, value: string) => void
  onDeleteManualStation: (stationId: string) => void
  onToggleEdgeTransfer: (edge: FullGraphEdge) => void
  onChangeEdgeMinutes: (edge: FullGraphEdge, minutesStr: string) => void
  onToggleEdgeDisabled: (edge: FullGraphEdge) => void
  onToggleStationHidden: (stationId: string) => void
  onSetNewEdgeTarget: (value: string) => void
  onSetManualEdges: (
    updater: (prev: Record<string, FullGraphEdge>) => Record<string, FullGraphEdge>,
  ) => void
  onSetInspectedStationId: (id: string | null) => void
  onFocusStation: (stationId: string) => void
  onResetStationEdits: (stationId: string) => void
  onUpdateStationGeoFromOSM?: (stationId: string) => Promise<void>
  onResetEdgeEdits: (edge: FullGraphEdge) => void
}

export function HubEditorPanel({
  inspectedStation,
  inspectedLineId,
  inspectedEdges,
  fullGraphLines,
  fullGraphEdges,
  stationOverrides,
  manualStations,
  manualEdges,
  hiddenStations,
  stationById,
  lineByNumericId,
  edgeOverrides,
  newEdgeTarget,
  findExactStationByName,
  edgeKey,
  onClose,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onChangeStationTitle,
  onChangeStationLine,
  onDeleteManualStation,
  onToggleEdgeTransfer,
  onChangeEdgeMinutes,
  onToggleEdgeDisabled,
  onToggleStationHidden,
  onSetNewEdgeTarget,
  onSetManualEdges,
  onSetInspectedStationId,
  onFocusStation,
  onResetStationEdits,
  onUpdateStationGeoFromOSM,
  onResetEdgeEdits,
}: HubEditorPanelProps) {
  const [activeTab, setActiveTab] = useState<'station' | 'line' | 'connections' | 'hub' | 'manual'>(
    'station',
  )
  const focusStation = (stationId: string) => {
    onSetInspectedStationId(stationId)
    onFocusStation(stationId)
  }
  const stationTitleOverride = stationOverrides[inspectedStation.id]?.title
  const [stationTitleDraft, setStationTitleDraft] = useState(() => {
    return stationTitleOverride ?? inspectedStation.title
  })
  const [edgeMinutesDraftByKey, setEdgeMinutesDraftByKey] = useState<Record<string, string>>({})

  useEffect(() => {
    setStationTitleDraft(stationTitleOverride ?? inspectedStation.title)
  }, [inspectedStation.id, inspectedStation.title, stationTitleOverride])

  useEffect(() => {
    setEdgeMinutesDraftByKey({})
  }, [inspectedStation.id, inspectedLineId])

  const [edgeAddError, setEdgeAddError] = useState<string | null>(null)

  const [geoUpdateStatus, setGeoUpdateStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [geoUpdateError, setGeoUpdateError] = useState<string | null>(null)

  return (
    <aside className="hub-editor-panel">
      <header className="hub-editor-header">
        <div className="hub-editor-title-row">
          <span className="hub-editor-title">
            {stationOverrides[inspectedStation.id]?.title ?? inspectedStation.title}
          </span>
          <button
            type="button"
            className="hub-editor-close"
            onClick={() => onSetInspectedStationId(null)}
            aria-label="Закрыть редактор хаба"
          >
            ×
          </button>
        </div>
        <div className="hub-editor-subtitle">
          ID: {inspectedStation.id}
          {inspectedLineId != null && (
            <>
              {' '}
              • Линия {inspectedLineId}
            </>
          )}
        </div>
      </header>

      <div className="hub-editor-tabs">
        <button
          type="button"
          className={`hub-editor-tab${activeTab === 'station' ? ' hub-editor-tab--active' : ''}`}
          onClick={() => setActiveTab('station')}
        >
          Станция
        </button>
        <button
          type="button"
          className={`hub-editor-tab${
            activeTab === 'connections' ? ' hub-editor-tab--active' : ''
          }`}
          onClick={() => setActiveTab('connections')}
        >
          Связи
        </button>
      </div>

      <div className="hub-editor-content">
        {activeTab === 'station' && (
          <>
            <section className="hub-editor-section">
              <div className="hub-editor-section-title">Параметры станции</div>
              <div className="hub-editor-field">
                <label className="hub-editor-field-label">Название</label>
                <input
                  type="text"
                  className="hub-editor-station-title-input"
                  value={stationTitleDraft}
                  onChange={(event) => setStationTitleDraft(event.target.value)}
                  // Enter фиксирует, Escape отменяет. Прежде название
                  // засчитывалось только при уходе фокуса: Ctrl+S прямо из
                  // поля сохранял старое имя, а набранное пропадало.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      setStationTitleDraft(stationTitleOverride ?? inspectedStation.title)
                      event.currentTarget.blur()
                    }
                  }}
                  onBlur={(event) => onChangeStationTitle(inspectedStation.id, event.target.value)}
                />
              </div>
              <div className="hub-editor-field">
                <label className="hub-editor-field-label">Линия</label>
                <select
                  className="hub-editor-line-select"
                  value={(() => {
                    const ov = stationOverrides[inspectedStation.id]
                    const effectiveLine =
                      ov && ov.lineNumericId !== undefined
                        ? ov.lineNumericId
                        : inspectedStation.lineNumericId
                    return effectiveLine != null ? String(effectiveLine) : ''
                  })()}
                  onChange={(event) =>
                    onChangeStationLine(inspectedStation.id, event.target.value)
                  }
                >
                  <option value="">— без линии —</option>
                  {fullGraphLines.map((line) => (
                    <option key={line.id} value={String(line.id)}>
                      {line.id} — {line.title}
                    </option>
                  ))}
                </select>
              </div>
              {manualStations[inspectedStation.id] && (
                <div className="hub-editor-field">
                  <button
                    type="button"
                    className="hub-editor-hub-remove-station"
                    onClick={() => onDeleteManualStation(inspectedStation.id)}
                  >
                    Удалить эту станцию
                  </button>
                </div>
              )}
              <div className="hub-editor-field">
                <button
                  type="button"
                  className="hub-editor-bulk-button"
                  onClick={() => onResetStationEdits(inspectedStation.id)}
                >
                  Сбросить изменения станции
                </button>
              </div>
            </section>

            <section className="hub-editor-section">
              <div className="hub-editor-section-title">Геокоординаты</div>
              <div className="hub-editor-section-subtitle">
                lat: {String(stationOverrides[inspectedStation.id]?.lat ?? inspectedStation.lat ?? '—')} • lon:{' '}
                {String(stationOverrides[inspectedStation.id]?.lon ?? inspectedStation.lon ?? '—')}
              </div>
              {onUpdateStationGeoFromOSM && (
                <>
                  <div className="hub-editor-field">
                    <button
                      type="button"
                      className="hub-editor-bulk-button"
                      disabled={geoUpdateStatus === 'loading'}
                      onClick={async () => {
                        setGeoUpdateError(null)
                        setGeoUpdateStatus('loading')
                        try {
                          await onUpdateStationGeoFromOSM(inspectedStation.id)
                          setGeoUpdateStatus('idle')
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : 'Не удалось обновить координаты'
                          setGeoUpdateError(msg)
                          setGeoUpdateStatus('error')
                        }
                      }}
                    >
                      Обновить lat/lon через OSM
                    </button>
                  </div>
                  {geoUpdateError && (
                    <div className="hub-editor-section-subtitle">{geoUpdateError}</div>
                  )}
                </>
              )}
            </section>

            <section className="hub-editor-section">
              <div className="hub-editor-section-title">Станция на схеме</div>
              <div className="hub-editor-section-subtitle">
                {hiddenStations[inspectedStation.id]
                  ? 'Станция скрыта на схеме'
                  : 'Станция отображается на схеме'}
              </div>
              <button
                type="button"
                className="hub-editor-hub-new"
                onClick={() => onToggleStationHidden(inspectedStation.id)}
              >
                {hiddenStations[inspectedStation.id] ? 'Показать станцию' : 'Скрыть станцию'}
              </button>
            </section>
          </>
        )}



        {activeTab === 'connections' && (
          <section className="hub-editor-section">
            <div className="hub-editor-section-title">Связи станции</div>
            <div className="hub-editor-edge-add-row">
              <input
                type="text"
                className={`hub-editor-edge-add-input${
                  edgeAddError ? ' hub-editor-edge-add-input--invalid' : ''
                }`}
                placeholder="ID или название станции"
                value={newEdgeTarget}
                onChange={(event) => onSetNewEdgeTarget(event.target.value)}
              />
              <button
                type="button"
                className="hub-editor-edge-add-button"
                onClick={() => {
                  const raw = newEdgeTarget.trim()
                  if (!raw || !inspectedStation) {
                    setEdgeAddError(null)
                    return
                  }

                  let target = stationById.get(raw)
                  let targetId = raw
                  if (!target) {
                    const byName = findExactStationByName(raw)
                    if (!byName) {
                      setEdgeAddError('Станция не найдена')
                      return
                    }
                    targetId = byName.id
                    target = byName
                  }
                  if (!target) {
                    setEdgeAddError('Станция не найдена')
                    return
                  }
                  if (targetId === inspectedStation.id) {
                    setEdgeAddError('Нельзя соединить станцию саму с собой')
                    return
                  }

                  const keyUndirected = edgeKey(inspectedStation.id, targetId)

                  const hasBase = fullGraphEdges.some((e) => {
                    const k = edgeKey(e.fromStationId, e.toStationId)
                    return k === keyUndirected
                  })
                  if (hasBase) {
                    setEdgeAddError('Ребро между этими станциями уже есть в основной схеме')
                    onSetNewEdgeTarget('')
                    return
                  }

                  const manualKey = `manual:${keyUndirected}`

                  if (manualEdges[manualKey]) {
                    setEdgeAddError('Ручное ребро между этими станциями уже создано')
                    onSetNewEdgeTarget('')
                    return
                  }

                  onSetManualEdges((prev) => {
                    if (prev[manualKey]) return prev

                    const defaultSeconds = 180
                    const newEdge: FullGraphEdge = {
                      fromStationId: inspectedStation.id,
                      toStationId: targetId,
                      lineNumericId:
                        inspectedStation.lineNumericId ?? target.lineNumericId ?? undefined,
                      medianTravelSeconds: defaultSeconds,
                      isTransfer: false,
                    }

                    return { ...prev, [manualKey]: newEdge }
                  })

                  setEdgeAddError(null)
                  onSetNewEdgeTarget('')
                }}
              >
                Добавить
              </button>
            </div>
            {edgeAddError && (
              <div className="hub-editor-error-text">{edgeAddError}</div>
            )}
            <ul className="hub-editor-list hub-editor-list--compact">
              {inspectedEdges.length === 0 && (
                <li className="hub-editor-list-item hub-editor-list-item--muted">
                  Нет явных рёбер для этой станции
                </li>
              )}
              {inspectedEdges.map((e, index) => {
                const otherId =
                  e.fromStationId === inspectedStation.id ? e.toStationId : e.fromStationId
                const other = stationById.get(otherId)
                const line =
                  e.lineNumericId != null ? lineByNumericId.get(e.lineNumericId) : undefined
                const key = edgeKey(e.fromStationId, e.toStationId)
                const edgeOverride = edgeOverrides[key]
                const manualKey = `manual:${key}`
                const isManual = !!manualEdges[manualKey]
                const effectiveIsTransfer =
                  edgeOverride && edgeOverride.isTransfer !== undefined
                    ? edgeOverride.isTransfer
                    : !!e.isTransfer
                const effectiveSeconds =
                  edgeOverride && edgeOverride.medianTravelSeconds !== undefined
                    ? edgeOverride.medianTravelSeconds
                    : e.medianTravelSeconds
                // Порог считаем в секундах: округление до минут относило
                // пересадку в 5:31 к дальним, а в 6:29 — к близким.
                const isFarTransfer = effectiveIsTransfer && effectiveSeconds >= 6 * 60
                const isDisabled = !!(edgeOverride && edgeOverride.disabled)
                const connectionLabel = !effectiveIsTransfer
                  ? 'перегон'
                  : isFarTransfer
                    ? 'пересадка (дальняя)'
                    : 'пересадка (близкая)'
                return (
                  <li
                    key={`${e.fromStationId}-${e.toStationId}-${index}`}
                    className={`hub-editor-list-item${
                      isDisabled ? ' hub-editor-list-item--edge-disabled' : ''
                    }`}
                  >
                    <span
                      className="hub-editor-line-dot"
                      style={line ? { backgroundColor: line.colorHex } : undefined}
                    />
                    <button
                      type="button"
                      className="hub-editor-connection-main hub-editor-connection-main--link"
                      onClick={() => focusStation(otherId)}
                    >
                      {stationOverrides[otherId]?.title ?? other?.title ?? otherId}
                    </button>
                    <button
                      type="button"
                      className={`hub-editor-connection-toggle${
                        effectiveIsTransfer ? ' hub-editor-connection-toggle--transfer' : ''
                      }`}
                      onClick={() => onToggleEdgeTransfer(e)}
                    >
                      {connectionLabel}
                    </button>
                    <div className="hub-editor-connection-meta">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="hub-editor-connection-minutes"
                        // Формат «м:сс», но голые секунды тоже принимаются —
                        // см. travelTime.ts. Поле было целочисленным в минутах
                        // и портило 97% значений при простом щелчке мимо.
                        title="Время в формате м:сс — можно ввести и просто секунды"
                        aria-label={`Время до «${other?.title ?? otherId}», формат м:сс`}
                        value={edgeMinutesDraftByKey[key] ?? formatTravelTime(effectiveSeconds)}
                        onChange={(event) =>
                          setEdgeMinutesDraftByKey((prev) => ({ ...prev, [key]: event.target.value }))
                        }
                        // Enter фиксирует значение, не дожидаясь ухода фокуса.
                        // Прежде правка засчитывалась только по blur, и Ctrl+S
                        // прямо из поля сохранял старое значение.
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') {
                            setEdgeMinutesDraftByKey((prev) => {
                              if (!(key in prev)) return prev
                              const next = { ...prev }
                              delete next[key]
                              return next
                            })
                            event.currentTarget.blur()
                          }
                        }}
                        onBlur={(event) => {
                          onChangeEdgeMinutes(e, event.target.value)
                          setEdgeMinutesDraftByKey((prev) => {
                            if (!(key in prev)) return prev
                            const next = { ...prev }
                            delete next[key]
                            return next
                          })
                        }}
                      />
                    </div>
                    {(isManual || edgeOverride) && (
                      <button
                        type="button"
                        className="hub-editor-bulk-button"
                        onClick={() => onResetEdgeEdits(e)}
                        title="Сбросить изменения ребра"
                        aria-label="Сбросить изменения ребра"
                      >
                        Сброс
                      </button>
                    )}
                    <button
                      type="button"
                      className={`hub-editor-edge-delete${
                        isDisabled ? ' hub-editor-edge-delete--restore' : ''
                      }`}
                      onClick={() => onToggleEdgeDisabled(e)}
                    >
                      {isDisabled ? 'Вернуть' : 'Удалить'}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

      </div>

      <footer className="hub-editor-footer">
        <div className="hub-editor-footer-history">
          <button
            type="button"
            className="hub-editor-footer-history-button"
            onClick={onUndo}
            disabled={!canUndo}
          >
            Отменить
          </button>
          <button
            type="button"
            className="hub-editor-footer-history-button"
            onClick={onRedo}
            disabled={!canRedo}
          >
            Повторить
          </button>
        </div>
        <button
          type="button"
          className="hub-editor-footer-button"
          onClick={onClose}
        >
          Готово
        </button>
      </footer>
    </aside>
  )
}
