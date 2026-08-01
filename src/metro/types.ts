export type LineId = string;

export interface Line {
  id: LineId;
  name: string;
  colorHex: string;
}

export interface Station {
  id: string;
  name: string;
  lineId: LineId;
}

export interface Connection {
  fromStationId: string;
  toStationId: string;
  /** Время в минутах между станциями или при пересадке */
  travelMinutes: number;
  /** true, если это пересадка между линиями */
  isTransfer?: boolean;
}

export interface RouteStep {
  fromStationId: string;
  toStationId: string;
  lineId: LineId;
  travelMinutes: number;
  isTransfer?: boolean;
  transferKind?: TransferKind;
}

export interface RouteResult {
  steps: RouteStep[];
  totalMinutes: number;
  transfersCount: number;
}

// Полный граф метро для всего приложения (данные приходят из оффлайн-пайплайна GTFS/OSM)

export interface FullGraphLine {
  /** Числовой ID линии из официальных данных (совпадает с fullStations/lineColors) */
  id: number;
  title: string;
  colorHex: string;
  /** Список ID станций этой линии в порядке следования на схеме/по графу */
  stationIds: string[];
}

export interface FullGraphStation {
  /** Уникальный ID станции внутри приложения, например "82-8" (stationId-lineId) */
  id: string;
  title: string;
  /** Числовой ID линии (может быть null для специальных узлов) */
  lineNumericId: number | null;
  /** Исходные координаты из GTFS/OSM для расчётов маршрута */
  lat?: number;
  lon?: number;
  /** Схемные координаты для Canvas (px), независимые от географии */
  layoutX?: number;
  layoutY?: number;
  /** Флаг пересадочного узла (есть хотя бы одна пересадка) */
  isTransfer?: boolean;
  /** ID пересадочного хаба, объединяющий несколько станций в один комплекс */
  hubId?: string;
  /** Исходный stop_id из GTFS, если есть привязка */
  stopId?: string;
}

export interface FullGraphEdge {
  /** Станции соседнего перегона или перехода */
  fromStationId: string;
  toStationId: string;
  /** Числовой ID линии, к которой относится перегон (если применимо) */
  lineNumericId?: number;
  /** Медианное время в секундах по данным расписания/наблюдений */
  medianTravelSeconds: number;
  /** Среднее время в секундах (для аналитики/отладки) */
  meanTravelSeconds?: number;
  /** Стандартное отклонение времени в секундах (для оценок надёжности) */
  stdTravelSeconds?: number;
  /** Количество использованных наблюдений/рейсов */
  samples?: number;
  /** true, если ребро соответствует пересадке (а не проезду по линии) */
  isTransfer?: boolean;
  transferKind?: TransferKind;
}

export interface EdgeOverride {
  isTransfer?: boolean;
  medianTravelSeconds?: number;
  disabled?: boolean;
}

export type TransferTimeSource =
  | 'gtfs_transfers'
  | 'schedule_estimate'
  | 'distance_estimate'
  | 'manual_override';

export type TransferKind =
  | 'near'
  | 'far'
  | 'out_of_station'
  | 'mcc'
  | 'mcd'
  | 'ignored';

export interface FullGraphTransferHub {
  /** Уникальный ID пересадочного узла/комплекса (например, "kievskaya-hub") */
  id: string;
  /** Список ID станций, входящих в этот узел */
  stationIds: string[];
  /** Минимальное рекомендуемое время пересадки (секунды) */
  minTransferSeconds: number;
  /** Источник оценки времени пересадки */
  source: TransferTimeSource;
}

/**
 * Аналитическая форма кольцевой линии, посчитанная оффлайн-солвером.
 *
 * Рантайм рисует кольца ctx.arc/ctx.ellipse ровно по этой форме и НЕ пересчитывает
 * её по координатам станций: точки могут лежать на кривой неравномерно, и повторная
 * подгонка по центроиду увела бы форму от данных.
 */
export type FullGraphRingShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

export interface FullGraphExport {
  lines: FullGraphLine[];
  stations: FullGraphStation[];
  edges: FullGraphEdge[];
  transferHubs: FullGraphTransferHub[];
  /**
   * Формы кольцевых линий: ключ — числовой ID линии строкой ("5", "95", "97").
   * Поле необязательное: для данных, собранных до появления проекции в солвере,
   * рантайм откатывается на подгонку формы по станциям.
   */
  ringShapes?: Record<string, FullGraphRingShape>;
}

/**
 * Форма кольцевой линии в `data/layout.json`.
 *
 * Совпадает с контрактом `ringShapes` в fullGraph.json: ровно circle/ellipse.
 * Раньше эллипс назывался `superellipse` и нёс `n`, `thickness`, `rotateDeg`,
 * `clockwise`, `thetaShift` — но суперэллипс с n=2 это и есть эллипс, а
 * остальные поля не читал никто: ни солвер, ни рантайм. Держать в формате
 * то, что нельзя нарисовать, — прямой путь к расхождению данных и картинки.
 */
export type LayoutRingShape =
  | {
      kind: 'circle';
      cx?: number;
      cy?: number;
      r?: number;
    }
  | {
      kind: 'ellipse';
      cx?: number;
      cy?: number;
      rx?: number;
      ry?: number;
    };

/**
 * Внутреннее состояние редактора для станции. В файл не выгружается: солвер
 * таких полей не читает, а `data/layout.json` хранит только координаты.
 */
export interface StationLayoutParams {
  gridPos?: { gx: number; gy: number };
  theta?: number;
}
