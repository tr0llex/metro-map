type LineId = string;

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
  /**
   * ПРИНАДЛЕЖНОСТЬ: все станции линии. Соседство по этому списку выводить
   * нельзя — ответвления идут в конец, и последняя станция основного хода
   * оказывается «соседом» первой станции ветки. Для соседства — `segments`.
   */
  stationIds: string[];
  /**
   * Ходы линии: сначала основной, затем по одному на ответвление. Ветка
   * начинается со станции, от которой отходит, поэтому полилиния связна, а
   * соседние элементы внутри сегмента — действительно соседние станции.
   */
  segments: string[][];
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
  /**
   * Координаты как они заданы в `data/layout.json` — ДО проекции колец и
   * разведения станций. Нужны только редактору: он видит уже обработанные
   * координаты, и выгрузка их обратно скармливала бы солверу его же выход.
   */
  sourceX?: number;
  sourceY?: number;
  /** Флаг пересадочного узла (есть хотя бы одна пересадка) */
  isTransfer?: boolean;
  /** ID пересадочного хаба, объединяющий несколько станций в один комплекс */
  hubId?: string;
}

export interface FullGraphEdge {
  /** Станции соседнего перегона или перехода */
  fromStationId: string;
  toStationId: string;
  /** Числовой ID линии, к которой относится перегон (если применимо) */
  lineNumericId?: number;
  /** Медианное время в секундах по данным расписания/наблюдений */
  medianTravelSeconds: number;
  /** true, если ребро соответствует пересадке (а не проезду по линии) */
  isTransfer?: boolean;
  transferKind?: TransferKind;
}

export interface EdgeOverride {
  isTransfer?: boolean;
  medianTravelSeconds?: number;
  disabled?: boolean;
}

/**
 * Откуда взято время пересадки. Значение ровно одно: узлы выводятся из
 * data/transfers.json. Прежние варианты (gtfs_transfers, schedule_estimate,
 * distance_estimate, manual_override) описывали пайплайн, которого больше нет,
 * и в данных не встречались — тип обещал разнообразие, которого не было.
 */
export type TransferTimeSource = 'data';

/**
 * Тип пересадки. Ровно эти четыре значения принимает загрузчик данных
 * (`transferKinds` в go-layout-solver/graph.go) — незнакомый тип останавливает
 * сборку. Прежде здесь были ещё 'mcd' и 'ignored': МЦД в проекте не
 * моделируются, а 'ignored' не выставлял никто. Проверки на них в рантайме
 * были ветками, куда нельзя попасть.
 */
type TransferKind = 'near' | 'far' | 'out_of_station' | 'mcc';

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

/**
 * Станция в том виде, в каком её принимает раскладка: только то, что влияет
 * на положение и подпись.
 */
export interface LayoutStation {
  id: string;
  title: string;
  lineId: number | null;
  hubId?: string;
}

/**
 * Станция с координатами схемы и цветом линии — ровно то, что рисует MetroMap.
 *
 * Координаты приходят готовыми из `normalized/fullGraph.json`: их расставляет
 * оффлайн-солвер, а рантайм не пересчитывает. Иначе узлы, снапнутые солвером
 * в одну точку, разъезжались бы на экране.
 */
export interface PositionedStation extends LayoutStation {
  x: number;
  y: number;
  lineColor: string;
}
