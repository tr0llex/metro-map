import type { RouteResult, FullGraphEdge, EdgeOverride } from './types';
import type { RoutingGraphData } from './routingGraphPayload';
import type { NeighborEdge } from './graphCore';
import {
  TRANSFER_PENALTY_MINUTES,
  buildAdjacencyListFromFullGraph,
  buildEdgeByKey,
  shortestPathFullGraphWithPenalty,
  canonicalPathKey,
  cloneAdjacencyWithPathPenalty,
  undirectedEdgeKey,
} from './graphCore';

/**
 * Модуль намеренно НЕ импортирует `./fullGraph`: он исполняется в веб-воркере,
 * который Vite собирает отдельным бандлом, и статический импорт данных приводил
 * к тому, что весь граф (~123 КБ) попадал в сборку второй раз. Данные подаются
 * снаружи через `setRoutingGraph()` — воркер делает это, загрузив компактный
 * ассет, тесты — напрямую из `fullGraph.ts`.
 */

interface PreparedGraph {
  stationIds: string[];
  edges: FullGraphEdge[];
  adjacency: Map<string, NeighborEdge[]>;
  edgeByKey: Map<string, FullGraphEdge>;
}

let prepared: PreparedGraph | null = null;

/** Задаёт граф и один раз считает производные структуры (смежность, индекс рёбер). */
export function setRoutingGraph(data: RoutingGraphData): void {
  prepared = {
    stationIds: data.stationIds,
    edges: data.edges,
    adjacency: buildAdjacencyListFromFullGraph(data.edges),
    edgeByKey: buildEdgeByKey(data.edges),
  };
}

export function isRoutingGraphReady(): boolean {
  return prepared !== null;
}

/** Сбрасывает граф. Нужен тестам, чтобы проверить поведение до инициализации. */
export function resetRoutingGraph(): void {
  prepared = null;
}

function requireGraph(): PreparedGraph {
  if (!prepared) {
    throw new Error('Граф маршрутизации не инициализирован: вызовите setRoutingGraph()');
  }
  return prepared;
}

// Поиск маршрута на основе полного графа (fullGraphEdges/fullGraphStations).
// Базовый вариант: оптимизация по времени с мягким штрафом за пересадку.
export function findShortestRouteFullGraph(
  startId: string,
  targetId: string,
  options?: {
    transferPenaltyMinutes?: number;
  },
): RouteResult | null {
  const graph = requireGraph();
  const transferPenaltyMinutes = options?.transferPenaltyMinutes ?? TRANSFER_PENALTY_MINUTES;
  const result = shortestPathFullGraphWithPenalty(
    startId,
    targetId,
    transferPenaltyMinutes,
    graph.adjacency,
    graph.edgeByKey,
    graph.stationIds,
  );
  return result ? result.route : null;
}

// Набор альтернативных маршрутов:
// 1) самый быстрый,
// 2) с минимальным числом пересадок,
// 3) остальные — по возрастанию времени (без дубликатов путей).
export function findRouteAlternativesFullGraph(
  startId: string,
  targetId: string,
  options?: {
    maxAlternatives?: number;
    edgeOverrides?: Record<string, EdgeOverride>;
    extraEdges?: FullGraphEdge[];
    transferPenaltyMinutes?: number;
    heavyTransferPenaltyMinutes?: number;
  },
): RouteResult[] {
  const graph = requireGraph();
  const maxAlternatives = options?.maxAlternatives ?? 6;
  const hasOverrides = !!options?.edgeOverrides;
  const extraEdges = options?.extraEdges ?? [];
  const useBaseGraph = !hasOverrides && extraEdges.length === 0;

  // Набор разных "настроек" штрафа за пересадки, чтобы получить разные компромиссы.
  const baseTransferPenalty = options?.transferPenaltyMinutes ?? TRANSFER_PENALTY_MINUTES;
  const heavyTransferPenalty =
    options?.heavyTransferPenaltyMinutes ?? (baseTransferPenalty > 0 ? baseTransferPenalty * 6 : 0);

  const penalties = [
    baseTransferPenalty, // базовый быстрый маршрут
    heavyTransferPenalty, // сильно штрафуем пересадки (если задано)
    0, // полностью игнорируем штраф пересадки (чистое время езды)
  ];

  const appliedEdges: FullGraphEdge[] = (() => {
    if (useBaseGraph) {
      return graph.edges;
    }

    const overrides = options?.edgeOverrides;
    const extra = extraEdges;

    // manual/extra edges имеют приоритет над базовыми при одинаковой паре станций
    const rawEdges: FullGraphEdge[] = [...extra, ...graph.edges];

    const result: FullGraphEdge[] = [];
    const seen = new Set<string>();

    for (const e of rawEdges) {
      const key = undirectedEdgeKey(e.fromStationId, e.toStationId);
      if (seen.has(key)) continue;
      seen.add(key);

      const ov = overrides?.[key];
      if (ov?.disabled) {
        continue;
      }

      let next = e;
      if (ov && ov.isTransfer !== undefined && ov.isTransfer !== e.isTransfer) {
        next = { ...next, isTransfer: ov.isTransfer };
      }
      if (ov && ov.medianTravelSeconds !== undefined && ov.medianTravelSeconds !== e.medianTravelSeconds) {
        next = { ...next, medianTravelSeconds: ov.medianTravelSeconds };
      }

      result.push(next);
    }

    return result;
  })();

  const allStationIds: string[] = (() => {
    if (useBaseGraph) {
      return graph.stationIds;
    }
    const set = new Set<string>(graph.stationIds);
    for (const e of appliedEdges) {
      set.add(e.fromStationId);
      set.add(e.toStationId);
    }
    return Array.from(set);
  })();

  const adjacency = useBaseGraph ? graph.adjacency : buildAdjacencyListFromFullGraph(appliedEdges);
  const edgeByKey = useBaseGraph ? graph.edgeByKey : buildEdgeByKey(appliedEdges);

  const candidates: { path: string[]; route: RouteResult }[] = [];
  const seenPathKeys = new Set<string>();

  for (const penalty of penalties) {
    const result = shortestPathFullGraphWithPenalty(
      startId,
      targetId,
      penalty,
      adjacency,
      edgeByKey,
      allStationIds,
    );
    if (!result) continue;
    const key = canonicalPathKey(result.path);
    if (seenPathKeys.has(key)) continue;
    seenPathKeys.add(key);
    candidates.push(result);
  }

  if (candidates.length === 0) {
    return [];
  }

  if (candidates.length < maxAlternatives) {
    const penaltyFactor = 3;

    // Штрафы накапливаем: каждый следующий прогон обходит рёбра ВСЕХ уже найденных
    // маршрутов, иначе поиск просто возвращает один из имеющихся кандидатов.
    let penalizedAdjacency = adjacency;
    for (const entry of candidates) {
      if (entry.path.length <= 1) continue;
      penalizedAdjacency = cloneAdjacencyWithPathPenalty(penalizedAdjacency, entry.path, penaltyFactor);
    }

    let guard = 0;
    while (candidates.length < maxAlternatives && guard < maxAlternatives * 2) {
      guard += 1;
      const altResult = shortestPathFullGraphWithPenalty(
        startId,
        targetId,
        baseTransferPenalty,
        penalizedAdjacency,
        edgeByKey,
        allStationIds,
      );
      if (!altResult || altResult.path.length <= 1) break;

      const altKey = canonicalPathKey(altResult.path);
      if (!seenPathKeys.has(altKey)) {
        seenPathKeys.add(altKey);
        candidates.push(altResult);
      }
      penalizedAdjacency = cloneAdjacencyWithPathPenalty(penalizedAdjacency, altResult.path, penaltyFactor);
    }
  }

  // Выбираем кандидата с минимальным временем
  let fastest = candidates[0];
  for (const c of candidates) {
    if (c.route.totalMinutes < fastest.route.totalMinutes) {
      fastest = c;
    }
  }

  // И кандидата с минимальным числом пересадок (при равенстве времени — быстрее).
  let fewestTransfers = candidates[0];
  for (const c of candidates) {
    if (c.route.transfersCount < fewestTransfers.route.transfersCount) {
      fewestTransfers = c;
    } else if (
      c.route.transfersCount === fewestTransfers.route.transfersCount &&
      c.route.totalMinutes < fewestTransfers.route.totalMinutes
    ) {
      fewestTransfers = c;
    }
  }

  const output: RouteResult[] = [];
  const usedKeys = new Set<string>();

  // Лимит проверяется ВНУТРИ pushUnique, а не только в цикле по others:
  // иначе при maxAlternatives = 1 в выдачу попадали оба приоритетных маршрута
  // (самый быстрый и с минимумом пересадок), когда это разные пути.
  const pushUnique = (entry: { path: string[]; route: RouteResult } | null) => {
    if (!entry) return;
    if (output.length >= maxAlternatives) return;
    const key = canonicalPathKey(entry.path);
    if (usedKeys.has(key)) return;
    usedKeys.add(key);
    output.push(entry.route);
  };

  pushUnique(fastest);
  pushUnique(fewestTransfers);

  // Остальные маршруты сортируем по возрастанию времени.
  //
  // И отсекаем заведомо бессмысленные. Альтернативы получаются накопительным
  // штрафованием уже найденных путей, поэтому после двух-трёх осмысленных
  // вариантов поиск начинает возвращать крюки через полгорода. На соседних
  // станциях это выглядело дико: Сокол → Аэропорт (один перегон, 3 минуты)
  // предлагал ещё 54, 56, 57, 67 и 71 минуту.
  //
  // Порог держит и абсолютный, и относительный запас: короткие маршруты
  // сравнивать в разах нельзя (3 → 6 минут это +100%, но всего 3 минуты
  // разницы), длинные — в минутах.
  const fastestMinutes = fastest.route.totalMinutes;
  const worstAcceptableMinutes = Math.max(fastestMinutes + 12, fastestMinutes * 1.6);

  const others = candidates
    .filter((c) => c !== fastest && c !== fewestTransfers)
    .filter((c) => c.route.totalMinutes <= worstAcceptableMinutes)
    .sort((a, b) => a.route.totalMinutes - b.route.totalMinutes);

  for (const c of others) {
    if (output.length >= maxAlternatives) break;
    pushUnique(c);
  }

  return output;
}
