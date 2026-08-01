package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
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

type HubOverride struct {
	MinTransferSeconds *int     `json:"minTransferSeconds,omitempty"`
	RotationDeg        *float64 `json:"rotationDeg,omitempty"`
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
// ТРЕБОВАНИЕ К UI (правка вне моих границ): canonicalRingShapeFromRingShape
// в src/components/MetroMap.tsx должна писать kind "ellipse" и не выдумывать
// поле n. Поля thickness/rotateDeg/clockwise/thetaShift не читает никто —
// ни солвер, ни рантайм; их незачем экспортировать.
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

type GraphOverrides struct {
	Layout   map[string]LayoutOverride  `json:"layout"`
	Stations map[string]StationOverride `json:"stations"`
	Lines    map[string]LineOverride    `json:"lines"`
	Edges    map[string]EdgeOverride    `json:"edges"`
	Hubs     map[string]HubOverride     `json:"hubs"`

	RingShapes map[string]RingShapeOverride `json:"ringShapes,omitempty"`
}

func readGraphOverrides(path string) (*GraphOverrides, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open editor overrides file: %w", err)
	}
	defer f.Close()

	dec := json.NewDecoder(f)
	var ov GraphOverrides
	if err := dec.Decode(&ov); err != nil {
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

		for key, eOv := range ov.Edges {
			isManual := eOv.Manual != nil && *eOv.Manual

			if isManual {
				if eOv.FromStationID == nil || eOv.ToStationID == nil {
					continue
				}
				fromID := *eOv.FromStationID
				toID := *eOv.ToStationID
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
		for i := range graph.TransferHubs {
			hub := &graph.TransferHubs[i]
			hov, ok := ov.Hubs[hub.ID]
			if !ok {
				continue
			}
			if hov.MinTransferSeconds != nil && *hov.MinTransferSeconds > 0 {
				hub.MinTransferSeconds = *hov.MinTransferSeconds
			}
			if hov.RotationDeg != nil && isFinite(*hov.RotationDeg) {
				hub.RotationDeg = *hov.RotationDeg
			}
		}
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
