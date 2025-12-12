import { useState } from 'react'
import type {
  FullGraphStation,
  FullGraphLine,
  FullGraphEdge,
  FullGraphTransferHub,
  EdgeOverride,
} from '../metro/types'

interface StationOverrideLite {
  title?: string
  lineNumericId?: number | null
}

interface HubEditorPanelProps {
  inspectedStation: FullGraphStation
  inspectedLineId: number | null
  inspectedLine: FullGraphLine | null
  inspectedLineEdges: FullGraphEdge[]
  inspectedHub: FullGraphTransferHub | null
  inspectedEdges: FullGraphEdge[]
  fullGraphLines: FullGraphLine[]
  fullGraphEdges: FullGraphEdge[]
  stationOverrides: Record<string, StationOverrideLite>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  stationHubOverrides: Record<string, string | null | undefined>
  hiddenStations: Record<string, true>
  availableHubIds: string[]
  baseHubIds: string[]
  stationById: Map<string, FullGraphStation>
  lineByNumericId: Map<number, FullGraphLine>
  effectiveLineStationIdsById: Map<number, string[]>
  edgeOverrides: Record<string, EdgeOverride>
  editorSelectedStationIds: string[]
  hubAddStationInput: string
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
  onChangeStationHub: (stationId: string, hubId: string | null) => void
  onChangeHubMinMinutes: (hubId: string, minutesStr: string) => void
  onToggleStationHidden: (stationId: string) => void
  onSetHubAddStationInput: (value: string) => void
  onSetNewEdgeTarget: (value: string) => void
  onSetManualEdges: (
    updater: (prev: Record<string, FullGraphEdge>) => Record<string, FullGraphEdge>,
  ) => void
  onSetInspectedStationId: (id: string | null) => void
  onRotateHubGeometry: (hubId: string, direction: 'cw' | 'ccw') => void
}

export function HubEditorPanel({
  inspectedStation,
  inspectedLineId,
  inspectedLine,
  inspectedLineEdges,
  inspectedHub,
  inspectedEdges,
  fullGraphLines,
  fullGraphEdges,
  stationOverrides,
  manualStations,
  manualEdges,
  stationHubOverrides,
  hiddenStations,
  availableHubIds,
  baseHubIds,
  stationById,
  lineByNumericId,
  effectiveLineStationIdsById,
  edgeOverrides,
  editorSelectedStationIds,
  hubAddStationInput,
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
  onChangeStationHub,
  onChangeHubMinMinutes,
  onToggleStationHidden,
  onSetHubAddStationInput,
  onSetNewEdgeTarget,
  onSetManualEdges,
  onSetInspectedStationId,
  onRotateHubGeometry,
}: HubEditorPanelProps) {
  const [activeTab, setActiveTab] = useState<'station' | 'line' | 'connections' | 'hub' | 'manual'>(
    'station',
  )
  const [hubAddError, setHubAddError] = useState<string | null>(null)
  const [edgeAddError, setEdgeAddError] = useState<string | null>(null)
  const [bulkLineId, setBulkLineId] = useState<string>('')
  const [bulkHubId, setBulkHubId] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFilterHiddenOnly, setSearchFilterHiddenOnly] = useState(false)
  const [searchFilterNoHubOnly, setSearchFilterNoHubOnly] = useState(false)
  const [searchFilterManualOnly, setSearchFilterManualOnly] = useState(false)

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  let searchResults: FullGraphStation[] = []
  if (normalizedSearchQuery.length >= 2) {
    const list: FullGraphStation[] = []
    for (const [sid, st] of stationById.entries()) {
      const title = stationOverrides[sid]?.title ?? st.title ?? sid
      const haystack = `${title} ${sid}`.toLowerCase()
      if (!haystack.includes(normalizedSearchQuery)) continue

      const isHidden = !!hiddenStations[sid]
      if (searchFilterHiddenOnly && !isHidden) continue

      const isManual = !!manualStations[sid]
      if (searchFilterManualOnly && !isManual) continue

      const override = stationHubOverrides[sid]
      let effHubId: string | null
      if (override === null) effHubId = null
      else if (override !== undefined) effHubId = override
      else effHubId = st.hubId ?? null
      if (searchFilterNoHubOnly && effHubId) continue

      list.push(st)
    }

    list.sort((a, b) => {
      const at = stationOverrides[a.id]?.title ?? a.title ?? a.id
      const bt = stationOverrides[b.id]?.title ?? b.title ?? b.id
      return at.localeCompare(bt, 'ru')
    })

    searchResults = list
  }

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
          className={`hub-editor-tab${activeTab === 'line' ? ' hub-editor-tab--active' : ''}`}
          onClick={() => setActiveTab('line')}
        >
          Линия
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
        <button
          type="button"
          className={`hub-editor-tab${activeTab === 'hub' ? ' hub-editor-tab--active' : ''}`}
          onClick={() => setActiveTab('hub')}
        >
          Хаб
        </button>
        <button
          type="button"
          className={`hub-editor-tab${activeTab === 'manual' ? ' hub-editor-tab--active' : ''}`}
          onClick={() => setActiveTab('manual')}
        >
          Ручные
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
                  defaultValue={
                    stationOverrides[inspectedStation.id]?.title ?? inspectedStation.title
                  }
                  onBlur={(event) =>
                    onChangeStationTitle(inspectedStation.id, event.target.value)
                  }
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

        {activeTab === 'line' && inspectedLine && (
          <section className="hub-editor-section">
            <div className="hub-editor-section-title">Линия станции</div>
            <div className="hub-editor-section-subtitle">
              Линия {inspectedLine.id}: {inspectedLine.title}
            </div>
            <ul className="hub-editor-list hub-editor-list--compact">
              {(effectiveLineStationIdsById.get(inspectedLine.id) ?? inspectedLine.stationIds).map(
                (sid: string) => {
                  const st = stationById.get(sid)
                  return (
                    <li
                      key={sid}
                      className="hub-editor-list-item hub-editor-list-item--clickable"
                      onClick={() => onSetInspectedStationId(sid)}
                    >
                      <span className="hub-editor-line-dot" />
                      <span className="hub-editor-station-name">
                        {stationOverrides[sid]?.title ?? st?.title ?? sid}
                      </span>
                    </li>
                  )
                },
              )}
            </ul>
            <div className="hub-editor-section-subtitle" style={{ marginTop: '0.35rem' }}>
              Рёбра линии
            </div>
            <ul className="hub-editor-list hub-editor-list--compact">
              {inspectedLineEdges.length === 0 && (
                <li className="hub-editor-list-item hub-editor-list-item--muted">
                  Нет явных рёбер для этой линии
                </li>
              )}
              {inspectedLineEdges.map((e, index) => {
                const from = stationById.get(e.fromStationId)
                const to = stationById.get(e.toStationId)
                const key = edgeKey(e.fromStationId, e.toStationId)
                const edgeOverride = edgeOverrides[key]
                const effectiveIsTransfer =
                  edgeOverride && edgeOverride.isTransfer !== undefined
                    ? edgeOverride.isTransfer
                    : !!e.isTransfer
                const effectiveSeconds =
                  edgeOverride && edgeOverride.medianTravelSeconds !== undefined
                    ? edgeOverride.medianTravelSeconds
                    : e.medianTravelSeconds
                const effectiveMinutes = Math.round(effectiveSeconds / 60)
                const isFarTransfer = effectiveIsTransfer && effectiveMinutes >= 6
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
                      style={{ backgroundColor: inspectedLine.colorHex }}
                    />
                    <button
                      type="button"
                      className="hub-editor-connection-main hub-editor-connection-main--link"
                      onClick={() => onSetInspectedStationId(e.fromStationId)}
                    >
                      {stationOverrides[e.fromStationId]?.title ?? from?.title ?? e.fromStationId}
                    </button>
                    <span className="hub-editor-connection-separator">→</span>
                    <button
                      type="button"
                      className="hub-editor-connection-main hub-editor-connection-main--link"
                      onClick={() => onSetInspectedStationId(e.toStationId)}
                    >
                      {stationOverrides[e.toStationId]?.title ?? to?.title ?? e.toStationId}
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
                        type="number"
                        min={1}
                        step={1}
                        className="hub-editor-connection-minutes"
                        defaultValue={effectiveMinutes}
                        onBlur={(event) => onChangeEdgeMinutes(e, event.target.value)}
                      />
                      <span className="hub-editor-connection-minutes-label">мин</span>
                    </div>
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

        {activeTab === 'hub' && (
          <>
            <section className="hub-editor-section">
              <div className="hub-editor-section-title">Хаб станции</div>
              <div className="hub-editor-section-subtitle">
                {(() => {
                  const override = stationHubOverrides[inspectedStation.id]
                  let effectiveHubId: string | null
                  if (override === null) effectiveHubId = null
                  else if (override !== undefined) effectiveHubId = override
                  else effectiveHubId = inspectedStation.hubId ?? null

                  if (!effectiveHubId) return 'Станция не входит ни в один хаб'
                  return `Текущий hubId: ${effectiveHubId}`
                })()}
              </div>
              <div className="hub-editor-hub-select-row">
                <select
                  className="hub-editor-hub-select"
                  value={(() => {
                    const override = stationHubOverrides[inspectedStation.id]
                    if (override === null) return ''
                    if (override !== undefined) return override
                    return inspectedStation.hubId ?? ''
                  })()}
                  onChange={(event) => {
                    const value = event.target.value
                    onChangeStationHub(inspectedStation.id, value === '' ? null : value)
                  }}
                >
                  <option value="">— без хаба —</option>
                  {availableHubIds.map((hubId) => (
                    <option key={hubId} value={hubId}>
                      {hubId}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="hub-editor-hub-new"
                  onClick={() => {
                    const newHubId = `manual-hub-${inspectedStation.id}`
                    onChangeStationHub(inspectedStation.id, newHubId)
                  }}
                >
                  + новый
                </button>
              </div>
            </section>

            {inspectedHub && (
              <section className="hub-editor-section">
                <div className="hub-editor-section-title">Хаб {inspectedHub.id}</div>
                <div className="hub-editor-section-subtitle">
                  Станций в хабе: {inspectedHub.stationIds.length}
                </div>
                <div className="hub-editor-hub-meta-row">
                  <span className="hub-editor-hub-meta-label">Мин. время пересадки</span>
                  <div className="hub-editor-hub-meta-input-wrap">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      className="hub-editor-hub-minutes-input"
                      defaultValue={Math.round(inspectedHub.minTransferSeconds / 60)}
                      onBlur={(event) =>
                        onChangeHubMinMinutes(inspectedHub.id, event.target.value)
                      }
                    />
                    <span className="hub-editor-hub-minutes-suffix">мин</span>
                  </div>
                </div>
                <div className="hub-editor-hub-meta-row">
                  <span className="hub-editor-hub-meta-label">Поворот хаба</span>
                  <div className="hub-editor-hub-meta-input-wrap">
                    <button
                      type="button"
                      className="hub-editor-hub-minutes-input"
                      onClick={() => onRotateHubGeometry(inspectedHub.id, 'ccw')}
                    >
                      ⟲ влево
                    </button>
                    <button
                      type="button"
                      className="hub-editor-hub-minutes-input"
                      onClick={() => onRotateHubGeometry(inspectedHub.id, 'cw')}
                      style={{ marginLeft: '0.25rem' }}
                    >
                      вправо ⟳
                    </button>
                  </div>
                </div>
                <div className="hub-editor-hub-add-row">
                  <input
                    type="text"
                    className={`hub-editor-hub-add-input${
                      hubAddError ? ' hub-editor-hub-add-input--invalid' : ''
                    }`}
                    placeholder="ID или название станции"
                    value={hubAddStationInput}
                    onChange={(event) => onSetHubAddStationInput(event.target.value)}
                  />
                  <button
                    type="button"
                    className="hub-editor-hub-add-button"
                    onClick={() => {
                      const raw = hubAddStationInput.trim()
                      if (!raw) {
                        setHubAddError(null)
                        return
                      }
                      const byId = stationById.get(raw)
                      let targetId = raw
                      let target = byId
                      if (!target) {
                        const byName = findExactStationByName(raw)
                        if (!byName) {
                          setHubAddError('Станция не найдена')
                          return
                        }
                        targetId = byName.id
                        target = byName
                      }
                      if (!target) {
                        setHubAddError('Станция не найдена')
                        return
                      }
                      setHubAddError(null)
                      onChangeStationHub(targetId, inspectedHub.id)
                      onSetHubAddStationInput('')
                    }}
                  >
                    Добавить
                  </button>
                </div>
                {hubAddError && (
                  <div className="hub-editor-error-text">{hubAddError}</div>
                )}
                <ul className="hub-editor-list">
                  {inspectedHub.stationIds.map((sid) => {
                    const st = stationById.get(sid)
                    const line =
                      st?.lineNumericId != null ? lineByNumericId.get(st.lineNumericId) : undefined
                    return (
                      <li
                        key={sid}
                        className="hub-editor-list-item hub-editor-list-item--clickable"
                        onClick={() => onSetInspectedStationId(sid)}
                      >
                        <span
                          className="hub-editor-line-dot"
                          style={line ? { backgroundColor: line.colorHex } : undefined}
                        />
                        <span className="hub-editor-station-name">
                          {stationOverrides[sid]?.title ?? st?.title ?? sid}
                        </span>
                        <button
                          type="button"
                          className="hub-editor-hub-remove-station"
                          onClick={(event) => {
                            event.stopPropagation()
                            onChangeStationHub(sid, null)
                          }}
                        >
                          Убрать
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
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
                const effectiveIsTransfer =
                  edgeOverride && edgeOverride.isTransfer !== undefined
                    ? edgeOverride.isTransfer
                    : !!e.isTransfer
                const effectiveSeconds =
                  edgeOverride && edgeOverride.medianTravelSeconds !== undefined
                    ? edgeOverride.medianTravelSeconds
                    : e.medianTravelSeconds
                const effectiveMinutes = Math.round(effectiveSeconds / 60)
                const isFarTransfer = effectiveIsTransfer && effectiveMinutes >= 6
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
                      onClick={() => onSetInspectedStationId(otherId)}
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
                        type="number"
                        min={1}
                        step={1}
                        className="hub-editor-connection-minutes"
                        defaultValue={effectiveMinutes}
                        onBlur={(event) => onChangeEdgeMinutes(e, event.target.value)}
                      />
                      <span className="hub-editor-connection-minutes-label">мин</span>
                    </div>
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

        {activeTab === 'manual' && (
          <section className="hub-editor-section">
            <div className="hub-editor-section-title">Ручные изменения</div>
            <div className="hub-editor-section-subtitle">
              {`Станций: ${Object.keys(manualStations).length} • Рёбер: ${Object.keys(manualEdges).length}`}
            </div>
            {editorSelectedStationIds.length > 0 && (
              <div className="hub-editor-bulk-row">
                <div className="hub-editor-section-subtitle">
                  {`Выбрано на карте: ${editorSelectedStationIds.length} станций`}
                </div>
                <div className="hub-editor-bulk-actions">
                  <button
                    type="button"
                    className="hub-editor-bulk-button"
                    onClick={() => {
                      for (const id of editorSelectedStationIds) {
                        if (!hiddenStations[id]) {
                          onToggleStationHidden(id)
                        }
                      }
                    }}
                  >
                    Скрыть
                  </button>
                  <button
                    type="button"
                    className="hub-editor-bulk-button"
                    onClick={() => {
                      for (const id of editorSelectedStationIds) {
                        if (hiddenStations[id]) {
                          onToggleStationHidden(id)
                        }
                      }
                    }}
                  >
                    Показать
                  </button>
                </div>
                <div className="hub-editor-bulk-actions">
                  <select
                    className="hub-editor-line-select"
                    value={bulkLineId}
                    onChange={(event) => setBulkLineId(event.target.value)}
                  >
                    <option value="">— выбрать линию —</option>
                    {fullGraphLines.map((line) => (
                      <option key={line.id} value={String(line.id)}>
                        {line.id} — {line.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="hub-editor-bulk-button"
                    onClick={() => {
                      const value = bulkLineId.trim()
                      if (!value) return
                      for (const id of editorSelectedStationIds) {
                        onChangeStationLine(id, value)
                      }
                    }}
                  >
                    Линия для всех
                  </button>
                </div>
                <div className="hub-editor-bulk-actions">
                  <select
                    className="hub-editor-hub-select"
                    value={bulkHubId}
                    onChange={(event) => setBulkHubId(event.target.value)}
                  >
                    <option value="">— выбрать хаб —</option>
                    {availableHubIds.map((hubId) => (
                      <option key={hubId} value={hubId}>
                        {hubId}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="hub-editor-bulk-button"
                    onClick={() => {
                      const value = bulkHubId.trim()
                      if (!value) return
                      for (const id of editorSelectedStationIds) {
                        onChangeStationHub(id, value)
                      }
                    }}
                  >
                    Хаб для всех
                  </button>
                  <button
                    type="button"
                    className="hub-editor-bulk-button"
                    onClick={() => {
                      for (const id of editorSelectedStationIds) {
                        onChangeStationHub(id, null)
                      }
                    }}
                  >
                    Убрать хаб
                  </button>
                </div>
              </div>
            )}
            <div className="hub-editor-section-subtitle" style={{ marginTop: '0.35rem' }}>
              Поиск станций
            </div>
            <div className="hub-editor-field">
              <input
                type="text"
                className="hub-editor-station-title-input"
                placeholder="Название или ID станции"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            {normalizedSearchQuery.length >= 2 && (
              <>
                <div className="hub-editor-bulk-actions">
                  <button
                    type="button"
                    className={`hub-editor-filter-chip${
                      searchFilterHiddenOnly ? ' hub-editor-filter-chip--active' : ''
                    }`}
                    onClick={() => setSearchFilterHiddenOnly((prev) => !prev)}
                  >
                    Только скрытые
                  </button>
                  <button
                    type="button"
                    className={`hub-editor-filter-chip${
                      searchFilterNoHubOnly ? ' hub-editor-filter-chip--active' : ''
                    }`}
                    onClick={() => setSearchFilterNoHubOnly((prev) => !prev)}
                  >
                    Без хаба
                  </button>
                  <button
                    type="button"
                    className={`hub-editor-filter-chip${
                      searchFilterManualOnly ? ' hub-editor-filter-chip--active' : ''
                    }`}
                    onClick={() => setSearchFilterManualOnly((prev) => !prev)}
                  >
                    Только ручные
                  </button>
                </div>
                {searchResults.length === 0 && (
                  <div className="hub-editor-section-subtitle">Ничего не найдено</div>
                )}
                {searchResults.length > 0 && (
                  <ul className="hub-editor-list hub-editor-list--compact">
                    {searchResults.slice(0, 80).map((st) => (
                      <li
                        key={st.id}
                        className="hub-editor-list-item hub-editor-list-item--clickable"
                        onClick={() => {
                          onSetInspectedStationId(st.id)
                          setActiveTab('station')
                        }}
                      >
                        <span className="hub-editor-line-dot" />
                        <span className="hub-editor-station-name">
                          {stationOverrides[st.id]?.title ?? st.title ?? st.id}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {Object.keys(manualStations).length > 0 && (
              <>
                <div className="hub-editor-section-subtitle">Ручные станции</div>
                <ul className="hub-editor-list hub-editor-list--compact">
                  {Object.values(manualStations).map((st) => (
                    <li
                      key={st.id}
                      className="hub-editor-list-item hub-editor-list-item--clickable"
                      onClick={() => {
                        onSetInspectedStationId(st.id)
                        setActiveTab('station')
                      }}
                    >
                      <span className="hub-editor-line-dot" />
                      <span className="hub-editor-station-name">
                        {stationOverrides[st.id]?.title ?? st.title ?? st.id}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {Object.keys(manualEdges).length > 0 && (
              <>
                <div className="hub-editor-section-subtitle">Ручные рёбра</div>
                <ul className="hub-editor-list hub-editor-list--compact">
                  {Object.values(manualEdges).map((e, index) => {
                    const from = stationById.get(e.fromStationId)
                    const to = stationById.get(e.toStationId)
                    return (
                      <li
                        key={`${e.fromStationId}-${e.toStationId}-${index}`}
                        className="hub-editor-list-item hub-editor-list-item--clickable"
                        onClick={() => {
                          onSetInspectedStationId(e.fromStationId)
                          setActiveTab('connections')
                        }}
                      >
                        <span className="hub-editor-line-dot" />
                        <span className="hub-editor-station-name">
                          {(stationOverrides[e.fromStationId]?.title ?? from?.title ?? e.fromStationId) +
                            ' → ' +
                            (stationOverrides[e.toStationId]?.title ?? to?.title ?? e.toStationId)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            {(() => {
              const baseSet = new Set(baseHubIds)
              const manualHubIds = new Set<string>()

              for (const value of Object.values(stationHubOverrides)) {
                if (value && !baseSet.has(value)) {
                  manualHubIds.add(value)
                }
              }

              for (const [sid, st] of stationById.entries()) {
                const override = stationHubOverrides[sid]
                let effHubId: string | null
                if (override === null) effHubId = null
                else if (override !== undefined) effHubId = override
                else effHubId = st.hubId ?? null
                if (effHubId && !baseSet.has(effHubId)) {
                  manualHubIds.add(effHubId)
                }
              }

              const list = Array.from(manualHubIds).sort()
              if (list.length === 0) return null

              return (
                <>
                  <div className="hub-editor-section-subtitle">Ручные хабы</div>
                  <ul className="hub-editor-list hub-editor-list--compact">
                    {list.map((hubId) => (
                      <li
                        key={hubId}
                        className="hub-editor-list-item hub-editor-list-item--clickable"
                        onClick={() => {
                          for (const [sid, st] of stationById.entries()) {
                            const override = stationHubOverrides[sid]
                            let effHubId: string | null
                            if (override === null) effHubId = null
                            else if (override !== undefined) effHubId = override
                            else effHubId = st.hubId ?? null
                            if (effHubId === hubId) {
                              onSetInspectedStationId(sid)
                              setActiveTab('hub')
                              break
                            }
                          }
                        }}
                      >
                        <span className="hub-editor-line-dot" />
                        <span className="hub-editor-station-name">{hubId}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            })()}
            {(() => {
              const degree = new Map<string, number>()
              for (const [sid] of stationById.entries()) {
                if (!hiddenStations[sid]) {
                  degree.set(sid, 0)
                }
              }

              const allEdges: FullGraphEdge[] = [
                ...fullGraphEdges,
                ...Object.values(manualEdges),
              ]

              for (const e of allEdges) {
                const key = edgeKey(e.fromStationId, e.toStationId)
                const override = edgeOverrides[key]
                if (override && override.disabled) continue
                if (hiddenStations[e.fromStationId] || hiddenStations[e.toStationId]) continue
                if (!degree.has(e.fromStationId) || !degree.has(e.toStationId)) continue
                degree.set(e.fromStationId, (degree.get(e.fromStationId) ?? 0) + 1)
                degree.set(e.toStationId, (degree.get(e.toStationId) ?? 0) + 1)
              }

              const danglingStations: FullGraphStation[] = []
              for (const [sid, deg] of degree.entries()) {
                if (deg === 0) {
                  const st = stationById.get(sid)
                  if (st) {
                    danglingStations.push(st)
                  }
                }
              }
              danglingStations.sort((a, b) => {
                const at = stationOverrides[a.id]?.title ?? a.title ?? a.id
                const bt = stationOverrides[b.id]?.title ?? b.title ?? b.id
                return at.localeCompare(bt, 'ru')
              })

              const hubCounts = new Map<string, number>()
              for (const hubId of baseHubIds) {
                hubCounts.set(hubId, 0)
              }
              for (const value of Object.values(stationHubOverrides)) {
                if (value && !hubCounts.has(value)) {
                  hubCounts.set(value, 0)
                }
              }
              for (const [sid, st] of stationById.entries()) {
                const override = stationHubOverrides[sid]
                let effHubId: string | null
                if (override === null) effHubId = null
                else if (override !== undefined) effHubId = override
                else effHubId = st.hubId ?? null
                if (!effHubId) continue
                if (hiddenStations[sid]) continue
                if (!hubCounts.has(effHubId)) {
                  hubCounts.set(effHubId, 0)
                }
                hubCounts.set(effHubId, (hubCounts.get(effHubId) ?? 0) + 1)
              }
              const emptyHubs = Array.from(hubCounts.entries())
                .filter(([, count]) => count === 0)
                .map(([id]) => id)
                .sort()

              type EdgeIssue = {
                kind: 'duplicate' | 'invalid'
                key: string
                fromId: string
                toId: string
                count: number
              }

              const edgeIssues: EdgeIssue[] = []
              const edgesByKey = new Map<string, FullGraphEdge[]>()

              for (const e of allEdges) {
                const key = edgeKey(e.fromStationId, e.toStationId)
                const override = edgeOverrides[key]
                if (override && override.disabled) continue

                const list = edgesByKey.get(key)
                if (list) list.push(e)
                else edgesByKey.set(key, [e])

                if (!stationById.get(e.fromStationId) || !stationById.get(e.toStationId)) {
                  edgeIssues.push({
                    kind: 'invalid',
                    key,
                    fromId: e.fromStationId,
                    toId: e.toStationId,
                    count: 1,
                  })
                }
              }

              for (const [key, edges] of edgesByKey.entries()) {
                if (edges.length > 1) {
                  const e = edges[0]
                  edgeIssues.push({
                    kind: 'duplicate',
                    key,
                    fromId: e.fromStationId,
                    toId: e.toStationId,
                    count: edges.length,
                  })
                }
              }

              const hasProblems =
                danglingStations.length > 0 || emptyHubs.length > 0 || edgeIssues.length > 0

              if (!hasProblems) {
                return (
                  <div className="hub-editor-section-subtitle">
                    Проверка схемы: явных проблем не найдено
                  </div>
                )
              }

              return (
                <>
                  <div className="hub-editor-section-subtitle">
                    Проверка схемы:
                    {danglingStations.length > 0 &&
                      ` висячие станции (${danglingStations.length})`}
                    {emptyHubs.length > 0 &&
                      `${danglingStations.length > 0 ? ' • ' : ' '}` +
                        `хабы без станций (${emptyHubs.length})`}
                    {edgeIssues.length > 0 &&
                      `${danglingStations.length > 0 || emptyHubs.length > 0 ? ' • ' : ' '}` +
                        `проблемные рёбра (${edgeIssues.length})`}
                  </div>

                  {danglingStations.length > 0 && (
                    <>
                      <div className="hub-editor-section-subtitle">Висячие станции</div>
                      <ul className="hub-editor-list hub-editor-list--compact">
                        {danglingStations.map((st) => (
                          <li
                            key={st.id}
                            className="hub-editor-list-item hub-editor-list-item--clickable"
                            onClick={() => {
                              onSetInspectedStationId(st.id)
                              setActiveTab('station')
                            }}
                          >
                            <span className="hub-editor-line-dot" />
                            <span className="hub-editor-station-name">
                              {stationOverrides[st.id]?.title ?? st.title ?? st.id}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {emptyHubs.length > 0 && (
                    <>
                      <div className="hub-editor-section-subtitle">Хабы без станций</div>
                      <ul className="hub-editor-list hub-editor-list--compact">
                        {emptyHubs.map((hubId) => (
                          <li
                            key={hubId}
                            className="hub-editor-list-item hub-editor-list-item--clickable"
                            onClick={() => {
                              setActiveTab('hub')
                            }}
                          >
                            <span className="hub-editor-line-dot" />
                            <span className="hub-editor-station-name">{hubId}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {edgeIssues.length > 0 && (
                    <>
                      <div className="hub-editor-section-subtitle">Проблемные рёбра</div>
                      <ul className="hub-editor-list hub-editor-list--compact">
                        {edgeIssues.map((issue) => {
                          const from = stationById.get(issue.fromId)
                          const to = stationById.get(issue.toId)
                          const fromLabel =
                            stationOverrides[issue.fromId]?.title ?? from?.title ?? issue.fromId
                          const toLabel =
                            stationOverrides[issue.toId]?.title ?? to?.title ?? issue.toId
                          const prefix =
                            issue.kind === 'duplicate' ? 'Дубликат' : 'Некорректное ребро'
                          const suffix = issue.count > 1 ? ` ×${issue.count}` : ''
                          return (
                            <li
                              key={`${issue.key}-${issue.kind}`}
                              className="hub-editor-list-item hub-editor-list-item--clickable"
                              onClick={() => {
                                onSetInspectedStationId(issue.fromId)
                                setActiveTab('connections')
                              }}
                            >
                              <span className="hub-editor-line-dot" />
                              <span className="hub-editor-station-name">
                                {`${prefix}: ${fromLabel} → ${toLabel}${suffix}`}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}
                </>
              )
            })()}
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
