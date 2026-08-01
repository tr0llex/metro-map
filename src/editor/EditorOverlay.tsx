import { lazy, Suspense } from 'react'
import { fullGraphEdges, fullGraphLines, fullGraphTransferHubs } from '../metro/fullGraph.ts'
import { buildEditorOverrides } from './exportOverrides.ts'
// Общий util живёт вне src/editor/**: им пользуется и прод. Обратной утечки нет —
// зависимость направлена только в одну сторону (редактор → utils).
import { copyTextToClipboard } from '../utils/clipboard.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

const HubEditorPanelLazy = lazy(() =>
  import('../components/HubEditorPanel.tsx').then((m) => ({ default: m.HubEditorPanel })),
)

const BASE_HUB_IDS = fullGraphTransferHubs.map((hub) => hub.id)

type EditorOverlayProps = {
  editor: EditorOverlayApi
  /** true, когда режим редактирования включён (панель и инструменты видимы) */
  active: boolean
}

/**
 * Весь редакторский UI: панель станции, FAB-кнопки (карандаш, «+», отладка
 * коллизий, OVR) и тост. Компонент грузится динамически и только в dev/editor
 * сборке — в прод-бандл он не попадает вообще.
 */
export function EditorOverlay({ editor, active }: EditorOverlayProps) {
  const handleCopyOverrides = async () => {
    try {
      const editorOverrides = buildEditorOverrides({
        layout: editor.lastLayoutOverrides,
        stationOverrides: editor.stationOverrides,
        stationHubOverrides: editor.stationHubOverrides,
        hiddenStations: editor.hiddenStations,
        manualStations: editor.manualStations,
        manualEdges: editor.manualEdges,
        edgeOverrides: editor.edgeOverrides,
        hubMinOverrides: editor.hubMinOverrides,
        hubRotationOverrides: editor.hubRotationOverrides,
        effectiveLineStationIdsById: editor.effectiveLineStationIdsById,
        canonicalGrid: editor.canonicalGrid,
        canonicalRingShapes: editor.canonicalRingShapes,
        canonicalStationParams: editor.canonicalStationParams,
        edgeKey: editor.edgeKey,
      })

      const json = JSON.stringify(editorOverrides, null, 2)
      const ok = json ? await copyTextToClipboard(json) : false
      if (ok) {
        editor.showToast('editor_overrides.json скопирован')
      } else {
        editor.showToast('Не удалось скопировать editor_overrides.json')
      }
    } catch {
      editor.showToast('Не удалось скопировать editor_overrides.json')
      // ignore clipboard errors
    }
  }

  return (
    <>
      {active && editor.inspectedStation && (
        <Suspense fallback={null}>
          <HubEditorPanelLazy
            inspectedStation={editor.inspectedStation}
            inspectedLineId={editor.inspectedLineId}
            inspectedLine={editor.inspectedLine}
            inspectedLineEdges={editor.inspectedLineEdges}
            inspectedHub={editor.inspectedHub}
            inspectedEdges={editor.inspectedEdges}
            fullGraphLines={fullGraphLines}
            fullGraphEdges={fullGraphEdges}
            stationOverrides={editor.stationOverrides}
            manualStations={editor.manualStations}
            manualEdges={editor.manualEdges}
            stationHubOverrides={editor.stationHubOverrides}
            hiddenStations={editor.hiddenStations}
            availableHubIds={editor.availableHubIds}
            baseHubIds={BASE_HUB_IDS}
            stationById={editor.stationById}
            lineByNumericId={editor.lineByNumericId}
            effectiveLineStationIdsById={editor.effectiveLineStationIdsById}
            edgeOverrides={editor.edgeOverrides}
            hubMinOverrides={editor.hubMinOverrides}
            hubRotationOverrides={editor.hubRotationOverrides}
            editorSelectedStationIds={editor.editorSelectedStationIds}
            hubAddStationInput={editor.hubAddStationInput}
            newEdgeTarget={editor.newEdgeTarget}
            findExactStationByName={editor.findExactStationByName}
            edgeKey={editor.edgeKey}
            onClose={editor.exitEditMode}
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onChangeStationTitle={editor.changeStationTitle}
            onChangeStationLine={editor.changeStationLine}
            onDeleteManualStation={editor.deleteManualStation}
            onToggleEdgeTransfer={editor.toggleEdgeTransfer}
            onChangeEdgeMinutes={editor.changeEdgeMinutes}
            onToggleEdgeDisabled={editor.toggleEdgeDisabled}
            onChangeStationHub={editor.changeStationHub}
            onChangeHubMinMinutes={editor.changeHubMinMinutes}
            onToggleStationHidden={editor.toggleStationHidden}
            onSetHubAddStationInput={editor.setHubAddStationInput}
            onSetNewEdgeTarget={editor.setNewEdgeTarget}
            onSetManualEdges={editor.setManualEdges}
            onSetInspectedStationId={editor.setInspectedStationId}
            onFocusStation={editor.focusStation}
            onRotateHubGeometry={editor.rotateHubGeometry}
            onMirrorHubGeometry={editor.mirrorHubGeometry}
            onUpdateStationGeoFromOSM={editor.updateStationGeoFromOSM}
            onResetStationEdits={editor.resetStationEdits}
            onResetEdgeEdits={editor.resetEdgeEdits}
            onResetHubEdits={editor.resetHubEdits}
            onResetAllEdits={editor.resetAllEdits}
          />
        </Suspense>
      )}

      <button
        type="button"
        className={`editor-fab${active ? ' editor-fab--active' : ''}`}
        onClick={editor.toggleEditMode}
        aria-label={active ? 'Выключить режим редактора' : 'Включить режим редактора'}
      >
        ✎
      </button>

      {active && (
        <div className="editor-tools-stack" aria-label="Инструменты редактора">
          <button
            type="button"
            className="editor-fab editor-fab--small editor-fab--secondary"
            onClick={editor.createManualStation}
            aria-label="Создать новую станцию рядом с текущей"
          >
            +
          </button>
          <button
            type="button"
            className={`editor-fab editor-fab--small${
              editor.collisionDebug ? ' editor-fab--active' : ''
            }`}
            onClick={editor.toggleCollisionDebug}
            aria-label={
              editor.collisionDebug
                ? 'Выключить отладку коллизий подписей'
                : 'Включить отладку коллизий подписей'
            }
          >
            ⚡
          </button>
          <button
            type="button"
            className="editor-fab editor-fab--small editor-fab--secondary"
            onClick={handleCopyOverrides}
            aria-label="Скопировать editor_overrides.json в буфер обмена"
            title="Скопировать editor_overrides.json"
          >
            OVR
          </button>
        </div>
      )}

      {editor.toast && (
        <div className="editor-toast" role="status" aria-live="polite">
          {editor.toast}
        </div>
      )}
    </>
  )
}
