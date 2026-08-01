package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

type OptionalString struct {
	Set   bool
	Value *string
}

func (o *OptionalString) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	o.Value = &s
	return nil
}

type StationOverride struct {
	Title         *string        `json:"title,omitempty"`
	LineNumericID *int           `json:"lineNumericId,omitempty"`
	HubID         OptionalString `json:"hubId"`
	Lat           *float64       `json:"lat,omitempty"`
	Lon           *float64       `json:"lon,omitempty"`
	Hidden        *bool          `json:"hidden,omitempty"`
	Manual        *bool          `json:"manual,omitempty"`
}

type LineOverride struct {
	StationIDs []string `json:"stationIds,omitempty"`
}

type EdgeOverride struct {
	FromStationID       *string `json:"fromStationId,omitempty"`
	ToStationID         *string `json:"toStationId,omitempty"`
	LineNumericID       *int    `json:"lineNumericId,omitempty"`
	MedianTravelSeconds *int    `json:"medianTravelSeconds,omitempty"`
	IsTransfer          *bool   `json:"isTransfer,omitempty"`
	Disabled            *bool   `json:"disabled,omitempty"`
	Manual              *bool   `json:"manual,omitempty"`
}

// HubOverride — ручные правки пересадочного узла из редактора.
//
// Поле rotationDeg удалено: его не читал никто — ни солвер, ни рантайм, — а
// привязка оверрайда к хабу шла только по нестабильному id вида "hub-N", без
// якоря, поэтому проверить актуальность 15 накопившихся записей было нечем.
//
// ЯКОРЬ. Ключ карты hubs — id вида "hub-N", а номер выдаётся порядком обхода
// компонент при построении графа: любая дедупликация станций сдвигает нумерацию,
// и оверрайд молча начинает править чужой узел (или ничей). Поэтому привязка
// идёт по составу узла: поле stationIds — отсортированный список ID станций.
//
//	"hubs": {
//	  "hub-19": {
//	    "stationIds": ["s-chkalovskaya-10", "s-kurskaya-3", "s-kurskaya-5"],
//	    "minTransferSeconds": 300
//	  }
//	}
//
// Требование к экспорту редактора (сторона TS) — в ROADMAP, раздел
// «Экспорт editor_overrides.json»: оверрайд хаба обязан нести якорь stationIds.
// Запись без якоря принимается, но проход о ней ругается в stdout.
type HubOverride struct {
	StationIDs         []string `json:"stationIds,omitempty"`
	MinTransferSeconds *int     `json:"minTransferSeconds,omitempty"`
}

// applyHubOverrides накладывает ручные правки узлов, привязываясь к составу
// узла, а не к его порядковому id.
//
// Осиротевшая привязка — не пустяк, а тихая потеря ручной правки, поэтому про
// каждую говорится вслух. Ошибкой сборки это не делается намеренно: оверрайды
// накапливаются годами, и упавшая сборка из-за одной устаревшей записи хуже,
// чем громкая строчка в логе.
func applyHubOverrides(graph *FullGraphExport, hubs map[string]HubOverride) {
	byAnchor := make(map[string]*FullGraphTransferHub, len(graph.TransferHubs))
	byID := make(map[string]*FullGraphTransferHub, len(graph.TransferHubs))
	for i := range graph.TransferHubs {
		hub := &graph.TransferHubs[i]
		byID[hub.ID] = hub
		if k := hubAnchorKey(hub.StationIDs); k != "" {
			byAnchor[k] = hub
		}
	}

	// Обход по отсортированным ключам: порядок сообщений не должен зависеть от
	// обхода map.
	keys := make([]string, 0, len(hubs))
	for k := range hubs {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		hov := hubs[key]

		var hub *FullGraphTransferHub
		switch {
		case len(hov.StationIDs) > 0:
			hub = byAnchor[hubAnchorKey(hov.StationIDs)]
			if hub == nil {
				fmt.Printf("hub override %s: якорь не найден — в графе нет узла из станций %v; правка ПРОПУЩЕНА\n",
					key, hov.StationIDs)
				continue
			}
			if hub.ID != key {
				fmt.Printf("hub override %s: якорь указывает на %s — номера хабов сдвинулись, ключ в editor_overrides.json устарел\n",
					key, hub.ID)
			}
		default:
			hub = byID[key]
			fmt.Printf("hub override %s: нет якоря stationIds, привязка идёт по нестабильному id — редактор обязан экспортировать якорь\n", key)
			if hub == nil {
				fmt.Printf("hub override %s: узла с таким id в графе нет; правка ПРОПУЩЕНА\n", key)
				continue
			}
		}

		if hov.MinTransferSeconds != nil && *hov.MinTransferSeconds > 0 {
			hub.MinTransferSeconds = *hov.MinTransferSeconds
		}
	}
}

// hubAnchorKey — канонический ключ состава узла. Сортировка обязательна: порядок
// станций внутри хаба построением графа не зафиксирован.
func hubAnchorKey(stationIDs []string) string {
	if len(stationIDs) == 0 {
		return ""
	}
	ids := append([]string(nil), stationIDs...)
	sort.Strings(ids)
	return strings.Join(ids, "\x00")
}

// RingShapeOverride — ручная форма кольца из редактора.
//
// ЕДИНЫЙ ФОРМАТ. Контракт с рантаймом (поле ringShapes в fullGraph.json,
// разбор в MetroMap.tsx) знает ровно два вида:
//
//	{"kind":"circle",  "cx":…, "cy":…, "r":…}
//	{"kind":"ellipse", "cx":…, "cy":…, "rx":…, "ry":…}
//
// Редактор при экспорте пишет третий вид — "superellipse". Это не отдельная
// геометрия: canonicalRingShapeFromRingShape в MetroMap.tsx конвертирует
// ellipse в superellipse с жёстко зашитым n = 2, а суперэллипс с n = 2 — это
// в точности эллипс. Поэтому здесь superellipse принимается как псевдоним
// ellipse при n = 2 (с допуском на округление) и отклоняется при любом другом
// n: рисовать настоящий суперэллипс рантайм всё равно не умеет, и молча
// подменять форму на эллипс значило бы разойтись с картинкой.
//
// Требование к UI (сторона TS) — в ROADMAP, раздел «Экспорт
// editor_overrides.json»: писать kind "ellipse" вместо "superellipse".
type RingShapeOverride struct {
	Kind string   `json:"kind"`
	Cx   *float64 `json:"cx,omitempty"`
	Cy   *float64 `json:"cy,omitempty"`
	R    *float64 `json:"r,omitempty"`
	Rx   *float64 `json:"rx,omitempty"`
	Ry   *float64 `json:"ry,omitempty"`
	N    *float64 `json:"n,omitempty"`
}

// shape приводит оверрайд к внутренней форме кольца. Второе значение — false,
// если форма не задана целиком или задана в виде, который рантайм не нарисует.
func (o RingShapeOverride) shape() (ringShape, bool) {
	if o.Cx == nil || o.Cy == nil || !isFinite(*o.Cx) || !isFinite(*o.Cy) {
		return ringShape{}, false
	}
	switch o.Kind {
	case "circle":
		if o.R == nil || !isFinite(*o.R) || *o.R <= 0 {
			return ringShape{}, false
		}
		return ringShape{kind: "circle", cx: *o.Cx, cy: *o.Cy, r: *o.R}, true
	case "ellipse", "superellipse":
		if o.Kind == "superellipse" && (o.N == nil || math.Abs(*o.N-2) > 1e-6) {
			return ringShape{}, false
		}
		if o.Rx == nil || o.Ry == nil || !isFinite(*o.Rx) || !isFinite(*o.Ry) || *o.Rx <= 0 || *o.Ry <= 0 {
			return ringShape{}, false
		}
		return ringShape{kind: "ellipse", cx: *o.Cx, cy: *o.Cy, rx: *o.Rx, ry: *o.Ry}, true
	}
	return ringShape{}, false
}

// ringShapeOverrides — формы колец, заданные вручную, по числовому id линии.
// Некорректные и нераспознанные записи пропускаются с предупреждением: тихо
// подменить форму значит разойтись с тем, что нарисует рантайм.
func ringShapeOverrides(ov *GraphOverrides) map[int]ringShape {
	if ov == nil || len(ov.RingShapes) == 0 {
		return nil
	}
	out := make(map[int]ringShape, len(ov.RingShapes))
	ids := make([]string, 0, len(ov.RingShapes))
	for idStr := range ov.RingShapes {
		ids = append(ids, idStr)
	}
	sort.Strings(ids)
	for _, idStr := range ids {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ringShapes: пропущен нечисловой id линии %q\n", idStr)
			continue
		}
		s, ok := ov.RingShapes[idStr].shape()
		if !ok {
			fmt.Fprintf(os.Stderr, "ringShapes: линия %d — форма %q не приводится к circle/ellipse, пропущена\n",
				id, ov.RingShapes[idStr].Kind)
			continue
		}
		out[id] = s
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// GraphOverrides — весь формат editor_overrides.json, который читает солвер.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: grid и stationParams (gridPos, theta). Редактор
// когда-то их экспортировал, json.Decoder молча их выбрасывал, и год никто не
// знал, что заданный вручную угол станции на кольце физически не доезжает до
// солвера. Поля не добавлены сознательно, а не по недосмотру:
//
//   - theta избыточен. В боевом режиме layout задаёт x/y ВСЕМ станциям схемы,
//     а ApplyRingProjection выводит угол станции из её x/y (ringShape.theta).
//     Ручной угол — второй источник правды о том же самом, и при расхождении
//     с x/y непонятно, кто прав. Дальше declump и ApplySeparation всё равно
//     двигают станции по углу, разводя их до ringMinChordPx, так что
//     «зафиксированный» угол не был бы зафиксирован.
//   - gridPos — сетка привязки в редакторе, у солвера понятия сетки нет вообще.
//
// Разбор шумит на любой неизвестный ключ (см. readGraphOverrides) — именно
// чтобы повторно наступить на эти грабли было невозможно.
type GraphOverrides struct {
	Layout   map[string]LayoutOverride  `json:"layout"`
	Stations map[string]StationOverride `json:"stations"`
	Lines    map[string]LineOverride    `json:"lines"`
	Edges    map[string]EdgeOverride    `json:"edges"`
	Hubs     map[string]HubOverride     `json:"hubs"`

	RingShapes map[string]RingShapeOverride `json:"ringShapes,omitempty"`
}

// knownOverrideKeys — ключи верхнего уровня, которые солвер действительно
// читает. Берутся рефлексией из json-тегов GraphOverrides, а не выписаны
// руками: список, который надо не забыть обновить, рано или поздно расходится
// со структурой, а тогда проверка начнёт врать на честном поле.
func knownOverrideKeys() map[string]struct{} {
	t := reflect.TypeOf(GraphOverrides{})
	out := make(map[string]struct{}, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			name = f.Name
		}
		out[name] = struct{}{}
	}
	return out
}

// rawEntryCount — сколько записей лежит под ключом. Нужно, чтобы из отчёта было
// сразу видно масштаб потери: «stationParams: 306 записей» читается совсем не
// так, как «stationParams: пусто».
func rawEntryCount(raw json.RawMessage) string {
	var asObject map[string]json.RawMessage
	if err := json.Unmarshal(raw, &asObject); err == nil {
		return fmt.Sprintf("записей: %d", len(asObject))
	}
	var asArray []json.RawMessage
	if err := json.Unmarshal(raw, &asArray); err == nil {
		return fmt.Sprintf("элементов: %d", len(asArray))
	}
	return "скалярное значение"
}

// reportUnknownOverrideKeys печатает неизвестные ключи верхнего уровня и
// возвращает их отсортированный список.
func reportUnknownOverrideKeys(path string, raw map[string]json.RawMessage) []string {
	known := knownOverrideKeys()
	unknown := make([]string, 0)
	for k := range raw {
		if _, ok := known[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)

	fmt.Fprintf(os.Stderr, "\n!!! editor overrides: в %s есть ключи, которых солвер НЕ ЧИТАЕТ:\n", path)
	for _, k := range unknown {
		fmt.Fprintf(os.Stderr, "!!!   %q — %s, ПРОИГНОРИРОВАНО ЦЕЛИКОМ\n", k, rawEntryCount(raw[k]))
	}
	fmt.Fprintf(os.Stderr, "!!! Либо экспорт редактора пишет лишнее, либо в GraphOverrides не хватает поля.\n")
	fmt.Fprintf(os.Stderr, "!!! Запустить с -strict_overrides, чтобы это стало ошибкой сборки.\n\n")
	return unknown
}

// readGraphOverrides читает editor_overrides.json.
//
// ПОЧЕМУ НЕ DisallowUnknownFields() ПО УМОЛЧАНИЮ. Именно молчание про
// неизвестные ключи стоило проекту года: редактор экспортировал grid и
// stationParams, декодер их выбрасывал, и никто не знал, что ручной угол
// станции на кольце до солвера не доезжает. Но жёсткий отказ по умолчанию
// плох по трём причинам сразу:
//
//   - DisallowUnknownFields падает на ПЕРВОМ неизвестном поле и называет только
//     его. Здесь нужно ровно обратное: полный список того, что потеряно, и
//     сколько записей в каждом ключе, — иначе чинить придётся по одному ключу
//     за сборку;
//   - оверрайды накапливаются годами и переживают несколько версий редактора.
//     Упавшая сборка карты из-за одного лишнего ключа в чужом старом файле
//     хуже, чем построенная карта с громким отчётом (та же логика, что у
//     осиротевших якорей хабов в applyHubOverrides);
//   - строгий режим на весь документ поймал бы заодно и опечатки внутри
//     station/edge-записей, где формат намеренно терпимый (частичные правки).
//
// Поэтому: по умолчанию — отчёт, который невозможно принять за обычный лог
// (stderr, префикс "!!!", пустые строки вокруг, слово ПРОИГНОРИРОВАНО и число
// потерянных записей); strict=true (флаг -strict_overrides) превращает его в
// ошибку сборки. Строгий режим включается в CI, где вывод никто не читает и
// потеряться предупреждению как раз проще всего.
func readGraphOverrides(path string, strict bool) (*GraphOverrides, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("open editor overrides file: %w", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode editor overrides json: %w", err)
	}

	if unknown := reportUnknownOverrideKeys(path, raw); len(unknown) > 0 && strict {
		return nil, fmt.Errorf("editor overrides: неизвестные ключи верхнего уровня %v (режим -strict_overrides)", unknown)
	}

	var ov GraphOverrides
	if err := json.Unmarshal(data, &ov); err != nil {
		return nil, fmt.Errorf("decode editor overrides json: %w", err)
	}
	return &ov, nil
}

func ApplyGraphOverrides(graph *FullGraphExport, ov *GraphOverrides) error {
	if graph == nil || ov == nil {
		return nil
	}

	stationByID := make(map[string]*FullGraphStation, len(graph.Stations))
	for i := range graph.Stations {
		st := &graph.Stations[i]
		stationByID[st.ID] = st
	}

	lineByID := make(map[int]*FullGraphLine, len(graph.Lines))
	for i := range graph.Lines {
		ln := &graph.Lines[i]
		lineByID[ln.ID] = ln
	}

	hiddenSet := make(map[string]struct{})
	if len(ov.Stations) > 0 {
		for id, sOv := range ov.Stations {
			st := stationByID[id]
			isManual := sOv.Manual != nil && *sOv.Manual
			if st == nil && isManual {
				st = &FullGraphStation{ID: id}
				graph.Stations = append(graph.Stations, *st)
				st = &graph.Stations[len(graph.Stations)-1]
				stationByID[id] = st
			}
			if st == nil {
				continue
			}
			if sOv.Title != nil {
				st.Title = *sOv.Title
			}
			if sOv.LineNumericID != nil {
				st.LineNumericID = *sOv.LineNumericID
			}
			if sOv.HubID.Set {
				if sOv.HubID.Value == nil {
					st.HubID = ""
				} else {
					st.HubID = *sOv.HubID.Value
				}
			}
			if sOv.Lat != nil && isFinite(*sOv.Lat) {
				st.Lat = *sOv.Lat
			}
			if sOv.Lon != nil && isFinite(*sOv.Lon) {
				st.Lon = *sOv.Lon
			}
			if sOv.Hidden != nil && *sOv.Hidden {
				hiddenSet[id] = struct{}{}
			}
		}
	}

	if len(ov.Lines) > 0 {
		for idStr, lOv := range ov.Lines {
			if len(lOv.StationIDs) == 0 {
				continue
			}
			id, err := strconv.Atoi(idStr)
			if err != nil {
				continue
			}
			ln := lineByID[id]
			if ln == nil {
				continue
			}
			ln.StationIDs = append([]string(nil), lOv.StationIDs...)
		}
	}

	if len(ov.Edges) > 0 {
		edgeKey := func(a, b string) string {
			if a < b {
				return a + "|" + b
			}
			return b + "|" + a
		}

		edgeIndicesByKey := make(map[string][]int)
		for i, e := range graph.Edges {
			k := edgeKey(e.FromStationID, e.ToStationID)
			edgeIndicesByKey[k] = append(edgeIndicesByKey[k], i)
		}

		// Обход по отсортированным ключам: добавление ручных рёбер меняет порядок
		// graph.Edges, а он попадает в fullGraph.json — при обходе map порядок
		// зависел бы от запуска, и сборка перестала бы быть воспроизводимой.
		edgeKeys := make([]string, 0, len(ov.Edges))
		for k := range ov.Edges {
			edgeKeys = append(edgeKeys, k)
		}
		sort.Strings(edgeKeys)

		for _, key := range edgeKeys {
			eOv := ov.Edges[key]
			isManual := eOv.Manual != nil && *eOv.Manual

			if isManual {
				if eOv.FromStationID == nil || eOv.ToStationID == nil {
					continue
				}
				fromID := *eOv.FromStationID
				toID := *eOv.ToStationID

				// Параллельное ребро — не безобидный дубль. Восстановление шагов
				// маршрута ищет ребро по неориентированной паре станций и двух
				// одинаковых пар различить не умеет: какое из рёбер описывает
				// пройденный шаг, определяется порядком в массиве. Поэтому
				// существующее ребро не дублируется, а перезаписывается — ручная
				// правка выигрывает у автоматической, но остаётся ровно одна.
				dupKey := edgeKey(fromID, toID)
				if idxs := edgeIndicesByKey[dupKey]; len(idxs) > 0 {
					fmt.Printf("edge override %s: ручное ребро %s—%s уже есть в графе (%d шт.) — существующее ПЕРЕЗАПИСАНО, дубликат не добавлен\n",
						key, fromID, toID, len(idxs))
					e := &graph.Edges[idxs[0]]
					e.FromStationID = fromID
					e.ToStationID = toID
					if eOv.LineNumericID != nil {
						e.LineNumericID = *eOv.LineNumericID
					}
					if eOv.MedianTravelSeconds != nil {
						e.MedianTravelSeconds = *eOv.MedianTravelSeconds
					}
					if eOv.IsTransfer != nil {
						e.IsTransfer = *eOv.IsTransfer
					}
					continue
				}

				e := FullGraphEdge{
					FromStationID: fromID,
					ToStationID:   toID,
				}
				if eOv.LineNumericID != nil {
					e.LineNumericID = *eOv.LineNumericID
				}
				if eOv.MedianTravelSeconds != nil {
					e.MedianTravelSeconds = *eOv.MedianTravelSeconds
				} else {
					e.MedianTravelSeconds = minTravelSeconds
				}
				if eOv.IsTransfer != nil {
					e.IsTransfer = *eOv.IsTransfer
				}
				graph.Edges = append(graph.Edges, e)
				// Индекс обязан учесть новое ребро: иначе второй ручной оверрайд
				// на ту же пару станций снова создаст параллельное ребро.
				edgeIndicesByKey[dupKey] = append(edgeIndicesByKey[dupKey], len(graph.Edges)-1)
				continue
			}

			idxs := edgeIndicesByKey[key]
			if len(idxs) == 0 {
				continue
			}

			if eOv.Disabled != nil && *eOv.Disabled {
				filtered := graph.Edges[:0]
				for _, e := range graph.Edges {
					if edgeKey(e.FromStationID, e.ToStationID) == key {
						continue
					}
					filtered = append(filtered, e)
				}
				graph.Edges = filtered
				edgeIndicesByKey = make(map[string][]int)
				for i, e := range graph.Edges {
					k := edgeKey(e.FromStationID, e.ToStationID)
					edgeIndicesByKey[k] = append(edgeIndicesByKey[k], i)
				}
				continue
			}

			for _, idx := range idxs {
				e := &graph.Edges[idx]
				if eOv.MedianTravelSeconds != nil {
					e.MedianTravelSeconds = *eOv.MedianTravelSeconds
				}
				if eOv.IsTransfer != nil {
					e.IsTransfer = *eOv.IsTransfer
				}
				if eOv.LineNumericID != nil {
					e.LineNumericID = *eOv.LineNumericID
				}
			}
		}
	}

	if len(ov.Hubs) > 0 {
		applyHubOverrides(graph, ov.Hubs)
	}

	if len(hiddenSet) > 0 {
		newStations := graph.Stations[:0]
		for _, st := range graph.Stations {
			if _, hidden := hiddenSet[st.ID]; hidden {
				continue
			}
			newStations = append(newStations, st)
		}
		graph.Stations = newStations

		for i := range graph.Lines {
			ln := &graph.Lines[i]
			if len(ln.StationIDs) == 0 {
				continue
			}
			ids := ln.StationIDs[:0]
			for _, id := range ln.StationIDs {
				if _, hidden := hiddenSet[id]; hidden {
					continue
				}
				ids = append(ids, id)
			}
			ln.StationIDs = ids
		}

		newEdges := graph.Edges[:0]
		for _, e := range graph.Edges {
			if _, hidden := hiddenSet[e.FromStationID]; hidden {
				continue
			}
			if _, hidden := hiddenSet[e.ToStationID]; hidden {
				continue
			}
			newEdges = append(newEdges, e)
		}
		graph.Edges = newEdges

		for i := range graph.TransferHubs {
			hub := &graph.TransferHubs[i]
			if len(hub.StationIDs) == 0 {
				continue
			}
			ids := hub.StationIDs[:0]
			for _, id := range hub.StationIDs {
				if _, hidden := hiddenSet[id]; hidden {
					continue
				}
				ids = append(ids, id)
			}
			hub.StationIDs = ids
		}
	}

	return nil
}
