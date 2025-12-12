package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

type StationOverride struct {
	Title         *string `json:"title,omitempty"`
	LineNumericID *int    `json:"lineNumericId,omitempty"`
	HubID         *string `json:"hubId,omitempty"`
	Hidden        *bool   `json:"hidden,omitempty"`
	Manual        *bool   `json:"manual,omitempty"`
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

type GraphOverrides struct {
	Layout   map[string]LayoutOverride  `json:"layout"`
	Stations map[string]StationOverride `json:"stations"`
	Lines    map[string]LineOverride    `json:"lines"`
	Edges    map[string]EdgeOverride    `json:"edges"`
	Hubs     map[string]HubOverride     `json:"hubs"`
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
			if sOv.HubID != nil {
				st.HubID = *sOv.HubID
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
