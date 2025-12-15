import type { RouteResult, FullGraphEdge, EdgeOverride } from './types';
import { fullGraphEdges, fullGraphStations } from './fullGraph';
import {
  TRANSFER_PENALTY_MINUTES,
  buildAdjacencyListFromFullGraph,
  buildEdgeByKey,
  shortestPathFullGraphWithPenalty,
  canonicalPathKey,
  cloneAdjacencyWithPathPenalty,
  undirectedEdgeKey,
} from './graphCore';

const fullGraphStationIds = fullGraphStations.map((s) => s.id);

const fullGraphAdjacency = buildAdjacencyListFromFullGraph(fullGraphEdges);
const fullGraphEdgeByKey = buildEdgeByKey(fullGraphEdges);

// Поиск маршрута на основе полного графа (fullGraphEdges/fullGraphStations).
// Базовый вариант: оптимизация по времени с мягким штрафом за пересадку.
export function findShortestRouteFullGraph(
  startId: string,
  targetId: string,
  options?: {
    transferPenaltyMinutes?: number;
  },
): RouteResult | null {
  const adjacency = fullGraphAdjacency;
  const edgeByKey = fullGraphEdgeByKey;
  const transferPenaltyMinutes = options?.transferPenaltyMinutes ?? TRANSFER_PENALTY_MINUTES;
  const result = shortestPathFullGraphWithPenalty(
    startId,
    targetId,
    transferPenaltyMinutes,
    adjacency,
    edgeByKey,
    fullGraphStationIds,
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
      return fullGraphEdges;
    }

    const overrides = options?.edgeOverrides;
    const extra = extraEdges;

    // manual/extra edges имеют приоритет над базовыми при одинаковой паре станций
    const rawEdges: FullGraphEdge[] = [...extra, ...fullGraphEdges];

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
      return fullGraphStationIds;
    }
    const set = new Set<string>(fullGraphStationIds);
    for (const e of appliedEdges) {
      set.add(e.fromStationId);
      set.add(e.toStationId);
    }
    return Array.from(set);
  })();

  const adjacency = useBaseGraph ? fullGraphAdjacency : buildAdjacencyListFromFullGraph(appliedEdges);
  const edgeByKey = useBaseGraph ? fullGraphEdgeByKey : buildEdgeByKey(appliedEdges);

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
    const baseEntries = [...candidates];
    const penaltyFactor = 3;
    for (const entry of baseEntries) {
      if (candidates.length >= maxAlternatives) break;
      if (entry.path.length <= 1) continue;

      const modifiedAdjacency = cloneAdjacencyWithPathPenalty(adjacency, entry.path, penaltyFactor);
      const altResult = shortestPathFullGraphWithPenalty(
        startId,
        targetId,
        baseTransferPenalty,
        modifiedAdjacency,
        edgeByKey,
        allStationIds,
      );
      if (!altResult) continue;
      const altKey = canonicalPathKey(altResult.path);
      if (seenPathKeys.has(altKey)) continue;
      seenPathKeys.add(altKey);
      candidates.push(altResult);
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

  const pushUnique = (entry: { path: string[]; route: RouteResult } | null) => {
    if (!entry) return;
    const key = canonicalPathKey(entry.path);
    if (usedKeys.has(key)) return;
    usedKeys.add(key);
    output.push(entry.route);
  };

  pushUnique(fastest);
  pushUnique(fewestTransfers);

  // Остальные маршруты сортируем по возрастанию времени.
  const others = candidates
    .filter((c) => c !== fastest && c !== fewestTransfers)
    .sort((a, b) => a.route.totalMinutes - b.route.totalMinutes);

  for (const c of others) {
    pushUnique(c);
    if (output.length >= maxAlternatives) break;
  }

  return output;
}
