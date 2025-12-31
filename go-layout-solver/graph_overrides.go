package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
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

func ApplyCanonicalLayoutOverrides(graph *FullGraphExport, ov *GraphOverrides) {
	if graph == nil || ov == nil {
		return
	}

	step := 8.0
	if ov.Grid != nil && ov.Grid.StepPx != nil && isFinite(*ov.Grid.StepPx) && *ov.Grid.StepPx > 0 {
		step = *ov.Grid.StepPx
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

	if len(ov.StationParams) > 0 {
		for id, p := range ov.StationParams {
			st := stationByID[id]
			if st == nil {
				continue
			}
			if p.GridPos != nil {
				st.LayoutX = float64(p.GridPos.GX) * step
				st.LayoutY = float64(p.GridPos.GY) * step
			}
		}
	}

	if len(ov.RingShapes) == 0 {
		return
	}

	shapeByLineID := make(map[int]RingShapeOverride)
	for idStr, s := range ov.RingShapes {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			continue
		}
		shapeByLineID[id] = s
	}

	if len(shapeByLineID) == 0 {
		return
	}

	for lineID, s := range shapeByLineID {
		ln := lineByID[lineID]
		if ln == nil {
			continue
		}
		if len(ln.StationIDs) < 3 {
			continue
		}
		applyRingShapeOverride(ln, stationByID, s, ov.StationParams)
	}
}

func applyRingShapeOverride(ln *FullGraphLine, stationByID map[string]*FullGraphStation, s RingShapeOverride, params map[string]StationLayoutParamsOverride) {
	if ln == nil {
		return
	}

	var cx, cy float64
	var sum int
	for _, sid := range ln.StationIDs {
		st := stationByID[sid]
		if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		cx += st.LayoutX
		cy += st.LayoutY
		sum += 1
	}
	if sum > 0 {
		cx /= float64(sum)
		cy /= float64(sum)
	}
	if s.Cx != nil && isFinite(*s.Cx) {
		cx = *s.Cx
	}
	if s.Cy != nil && isFinite(*s.Cy) {
		cy = *s.Cy
	}

	kind := s.Kind
	if kind == "" {
		kind = "circle"
	}

	if kind == "circle" {
		r := 0.0
		if s.R != nil && isFinite(*s.R) && *s.R > 0 {
			r = *s.R
		} else {
			var rs float64
			var cnt int
			for _, sid := range ln.StationIDs {
				st := stationByID[sid]
				if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
					continue
				}
				rs += math.Hypot(st.LayoutX-cx, st.LayoutY-cy)
				cnt += 1
			}
			if cnt > 0 {
				r = rs / float64(cnt)
			}
		}
		if !isFinite(r) || r <= 0 {
			return
		}
		applyRingPlacement(ln, stationByID, params, func(theta float64) (float64, float64) {
			return cx + r*math.Cos(theta), cy + r*math.Sin(theta)
		})
		return
	}

	// superellipse
	rx := 0.0
	ry := 0.0
	if s.Rx != nil && isFinite(*s.Rx) && *s.Rx > 0 {
		rx = *s.Rx
	}
	if s.Ry != nil && isFinite(*s.Ry) && *s.Ry > 0 {
		ry = *s.Ry
	}
	if (!isFinite(rx) || rx <= 0) || (!isFinite(ry) || ry <= 0) {
		// fallback: estimate axes from current points
		var sumDx2, sumDy2 float64
		var cnt int
		for _, sid := range ln.StationIDs {
			st := stationByID[sid]
			if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
				continue
			}
			dx := st.LayoutX - cx
			dy := st.LayoutY - cy
			sumDx2 += dx * dx
			sumDy2 += dy * dy
			cnt += 1
		}
		if cnt > 0 {
			vx := sumDx2 / float64(cnt)
			vy := sumDy2 / float64(cnt)
			if vx > 0 && vy > 0 {
				ratio := math.Sqrt(vx / vy)
				if ratio < 1.1 {
					ratio = 1.1
				} else if ratio > 3.0 {
					ratio = 3.0
				}
				baseR := math.Sqrt(vx+vy) * 0.9
				den := math.Sqrt((ratio*ratio + 1) / 2)
				if den > 0 {
					s := baseR / den
					rx = ratio * s
					ry = s
				}
			}
		}
	}
	if !isFinite(rx) || !isFinite(ry) || rx <= 0 || ry <= 0 {
		return
	}

	n := 2.0
	if s.N != nil && isFinite(*s.N) {
		n = *s.N
	}
	if n < 2 {
		n = 2
	}
	if n > 10 {
		n = 10
	}

	applyRingPlacement(ln, stationByID, params, func(theta float64) (float64, float64) {
		c := math.Cos(theta)
		sn := math.Sin(theta)
		x := math.Copysign(math.Pow(math.Abs(c), 2.0/n), c)
		y := math.Copysign(math.Pow(math.Abs(sn), 2.0/n), sn)
		return cx + rx*x, cy + ry*y
	})
}

func applyRingPlacement(
	ln *FullGraphLine,
	stationByID map[string]*FullGraphStation,
	params map[string]StationLayoutParamsOverride,
	pointAt func(theta float64) (float64, float64),
) {
	n := len(ln.StationIDs)
	for i, sid := range ln.StationIDs {
		st := stationByID[sid]
		if st == nil {
			continue
		}
		theta := (2*math.Pi*float64(i)/float64(n) - math.Pi/2)
		if params != nil {
			p, ok := params[sid]
			if ok && p.Theta != nil && isFinite(*p.Theta) {
				theta = *p.Theta
			}
		}
		x, y := pointAt(theta)
		if isFinite(x) && isFinite(y) {
			st.LayoutX = x
			st.LayoutY = y
		}
	}
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

type GridOverride struct {
	StepPx *float64 `json:"stepPx,omitempty"`
}

type RingShapeOverride struct {
	Kind       string   `json:"kind"`
	Cx         *float64 `json:"cx,omitempty"`
	Cy         *float64 `json:"cy,omitempty"`
	R          *float64 `json:"r,omitempty"`
	Rx         *float64 `json:"rx,omitempty"`
	Ry         *float64 `json:"ry,omitempty"`
	N          *float64 `json:"n,omitempty"`
	Thickness  *float64 `json:"thickness,omitempty"`
	RotateDeg  *float64 `json:"rotateDeg,omitempty"`
	Clockwise  *bool    `json:"clockwise,omitempty"`
	ThetaShift *float64 `json:"thetaShift,omitempty"`
}

type StationLayoutParamsOverride struct {
	GridPos *struct {
		GX int `json:"gx"`
		GY int `json:"gy"`
	} `json:"gridPos,omitempty"`
	Theta *float64 `json:"theta,omitempty"`
}

type GraphOverrides struct {
	Layout   map[string]LayoutOverride  `json:"layout"`
	Stations map[string]StationOverride `json:"stations"`
	Lines    map[string]LineOverride    `json:"lines"`
	Edges    map[string]EdgeOverride    `json:"edges"`
	Hubs     map[string]HubOverride     `json:"hubs"`

	Grid          *GridOverride                          `json:"grid,omitempty"`
	RingShapes    map[string]RingShapeOverride           `json:"ringShapes,omitempty"`
	StationParams map[string]StationLayoutParamsOverride `json:"stationParams,omitempty"`
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
