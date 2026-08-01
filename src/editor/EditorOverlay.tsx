import { lazy, Suspense } from 'react'
import { fullGraphEdges, fullGraphLines, fullGraphTransferHubs } from '../metro/fullGraph.ts'
import { buildLayoutFile } from './exportLayout.ts'
// Общий util живёт вне src/editor/**: им пользуется и прод. Обратной утечки нет —
// зависимость направлена только в одну сторону (редактор → utils).
import { copyTextToClipboard } from '../utils/clipboard.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

const HubEditorPanelLazy = lazy(() =>
  import('../components/HubEditorPanel.tsx').then((m) => ({ default: m.HubEditorPanel })),
)

const BASE_HUB_IDS = fullGraphTransferHubs.map((hub) => hub.id)

/**
 * Сколько правок редактора НЕ относится к координатам. Такие правки экспорт не
 * выгружает: их место — в `data/lines/*.json` и `data/transfers.json`.
 */
function countNonLayoutEdits(editor: EditorOverlayApi): number {
  return (
    Object.keys(editor.stationOverrides).length +
    Object.keys(editor.manualStations).length +
    Object.keys(editor.manualEdges).length +
    Object.keys(editor.edgeOverrides).length +
    Object.keys(editor.hubMinOverrides).length +
    Object.keys(editor.hiddenStations).length +
    Object.keys(editor.stationHubOverrides).length
  )
}

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
      // Формы колец фиксируются ТОЛЬКО по явному согласию: сейчас солвер
      // подбирает их по станциям, и молчаливое добавление `ringShapes` в файл
      // переключило бы геометрию колец на ручную без единого следа в выводе.
      const hasRingShapes = Object.keys(editor.canonicalRingShapes).length > 0
      const includeRingShapes =
        hasRingShapes &&
        window.confirm(
          'Зафиксировать формы кольцевых линий (rings) в data/layout.json?\n\n' +
            'Сейчас солвер подбирает форму каждого кольца по станциям. Если зафиксировать, ' +
            'форма перестанет подстраиваться под правки раскладки.\n\n' +
            'ОК — записать формы, Отмена — оставить автоподгонку (обычный вариант).',
        )

      const layoutFile = buildLayoutFile({
        layout: editor.lastLayoutOverrides,
        canonicalRingShapes: editor.canonicalRingShapes,
        includeRingShapes,
      })

      const json = JSON.stringify(layoutFile, null, 2)
      const ok = json ? await copyTextToClipboard(json) : false
      if (ok) {
        // Правки, кроме координат, в файл не попадают: название станции, состав
        // линии, время перегона и параметры узла теперь живут в data/lines/*.json
        // и data/transfers.json. Молча скопировать один только layout значило бы
        // потерять их без предупреждения — поэтому говорим об этом вслух.
        const otherEdits = countNonLayoutEdits(editor)
        if (otherEdits > 0) {
          editor.showToast(
            `data/layout.json скопирован. Правок не по координатам: ${otherEdits} — ` +
              'они не выгружаются, их нужно внести в data/lines/*.json или data/transfers.json',
          )
        } else {
          editor.showToast(
            includeRingShapes
              ? 'data/layout.json скопирован (с формами колец)'
              : 'data/layout.json скопирован',
          )
        }
      } else {
        editor.showToast('Не удалось скопировать data/layout.json')
      }
    } catch {
      editor.showToast('Не удалось скопировать data/layout.json')
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
            aria-label="Скопировать data/layout.json в буфер обмена"
            title="Скопировать data/layout.json"
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
