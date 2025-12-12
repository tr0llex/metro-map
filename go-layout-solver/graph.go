package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// --- Public graph types exported to JSON ---

type FullGraphLine struct {
	ID         int      `json:"id"`
	Title      string   `json:"title"`
	ColorHex   string   `json:"colorHex"`
	StationIDs []string `json:"stationIds"`
}

type FullGraphStation struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	LineNumericID int     `json:"lineNumericId"`
	IsTransfer    bool    `json:"isTransfer"`
	HubID         string  `json:"hubId,omitempty"`
	Lat           float64 `json:"lat,omitempty"`
	Lon           float64 `json:"lon,omitempty"`
	LayoutX       float64 `json:"layoutX,omitempty"`
	LayoutY       float64 `json:"layoutY,omitempty"`
	YandexX       float64 `json:"yandexX,omitempty"`
	YandexY       float64 `json:"yandexY,omitempty"`
}

type FullGraphEdge struct {
	FromStationID       string `json:"fromStationId"`
	ToStationID         string `json:"toStationId"`
	LineNumericID       int    `json:"lineNumericId,omitempty"`
	MedianTravelSeconds int    `json:"medianTravelSeconds"`
	IsTransfer          bool   `json:"isTransfer,omitempty"`
	TransferKind        string `json:"transferKind,omitempty"`
}

type FullGraphTransferHub struct {
	ID                 string   `json:"id"`
	StationIDs         []string `json:"stationIds"`
	MinTransferSeconds int      `json:"minTransferSeconds"`
	Source             string   `json:"source"`
	RotationDeg        float64  `json:"rotationDeg,omitempty"`
}

type FullGraphExport struct {
	Lines        []FullGraphLine        `json:"lines"`
	Stations     []FullGraphStation     `json:"stations"`
	Edges        []FullGraphEdge        `json:"edges"`
	TransferHubs []FullGraphTransferHub `json:"transferHubs"`
}

// yandexCoordsMap хранит координаты со схемы Яндекса по нормализованному имени станции.
// Формат JSON (normalized/yandex_coords.json), который пишет scripts/extract_yandex_coords.ts:
//
//	{
//	  "библиотека им ленина": [ { "title": "Библиотека имени Ленина", "x": 1234, "y": 567 }, ... ],
//	  ...
//	}
type yandexCoordEntry struct {
	Title string  `json:"title"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

// --- Internal helpers ---

type csvRow struct {
	CityID           int
	CityName         string
	LineID           int
	LineName         string
	LineColorHex     string
	StationNumericID string
	StationName      string
	Lat              float64
	Lng              float64
	Order            int
}

type connectionRecord struct {
	FromStation string `json:"from_station"`
	FromLine    string `json:"from_line"`
	ToStation   string `json:"to_station"`
	ToLine      string `json:"to_line"`
	Type        string `json:"type"`
}

const (
	minTravelSeconds      = 40
	avgTrainSpeedKmH      = 40
	baseTransferSeconds   = 240
	maxCompactHubDistance = 0.35
	targetCityName        = "Москва"
	// baseRunSeconds — константная надбавка на старт/остановку поезда для каждого перегона.
	baseRunSeconds = 20
)

var (
	ringLineIDs = map[int]struct{}{
		5:  {}, // Кольцевая
		95: {}, // МЦК
		97: {}, // БКЛ
	}

	allowedConnectionTypes = map[string]struct{}{
		"interchange":    {},
		"cross_platform": {},
		"mcc":            {},
		"out-of-station": {},
	}

	mcdRe = regexp.MustCompile(`(?i)мцд`)
)

// BuildFullGraph читает metro.ru.csv, connections.json и, опционально, координаты Яндекс-схемы,
// после чего возвращает полный граф.
// yandexPath может быть пустой строкой — тогда координаты Яндекс просто игнорируются.
func BuildFullGraph(csvPath, connPath, yandexPath string) (FullGraphExport, error) {
	absCSV, err := resolvePath(csvPath)
	if err != nil {
		return FullGraphExport{}, err
	}
	absConn, err := resolvePath(connPath)
	if err != nil {
		return FullGraphExport{}, err
	}

	rows, err := loadCSVRows(absCSV)
	if err != nil {
		return FullGraphExport{}, err
	}
	if len(rows) == 0 {
		return FullGraphExport{}, fmt.Errorf("no rows for %s", targetCityName)
	}

	linesMap := groupRowsByLine(rows)

	// Опционально подгружаем координаты станций со схемы Яндекса.
	var yandexByName map[string][]yandexCoordEntry
	if strings.TrimSpace(yandexPath) != "" {
		absYandex, err := resolvePath(yandexPath)
		if err == nil {
			data, readErr := os.ReadFile(absYandex)
			if readErr == nil {
				var raw map[string][]yandexCoordEntry
				if jsonErr := json.Unmarshal(data, &raw); jsonErr == nil {
					// Перенормализуем ключи тем же normalizeStationName, что и у станций,
					// чтобы не было расхождений вроде "Библиотека имени Ленина" vs "Библиотека им.Ленина".
					normalized := make(map[string][]yandexCoordEntry)
					for key, entries := range raw {
						norm := normalizeStationName(key)
						bucket := normalized[norm]
						bucket = append(bucket, entries...)
						normalized[norm] = bucket
					}
					yandexByName = normalized
				} else {
					fmt.Fprintf(os.Stderr, "warn: cannot parse yandex coords json: %v\n", jsonErr)
				}
			} else {
				fmt.Fprintf(os.Stderr, "warn: cannot read yandex coords file: %v\n", readErr)
			}
		} else {
			fmt.Fprintf(os.Stderr, "warn: cannot resolve yandex coords path: %v\n", err)
		}
	}

	// Индекс станций по (нормализованное имя линии, нормализованное имя станции)
	lineKeyToStationName := make(map[string]map[string]string)

	stationByID := make(map[string]*FullGraphStation)
	var lines []FullGraphLine
	var edges []FullGraphEdge

	for _, agg := range linesMap {
		lineKey := normalizeLineKeyFromCSV(agg.LineName)

		// сортируем станции по order
		ordered := make([]csvRow, len(agg.Rows))
		copy(ordered, agg.Rows)
		sort.Slice(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

		stationIDsForLine := make([]string, 0, len(ordered))

		for _, r := range ordered {
			id := fmt.Sprintf("mos-%d-%s", r.LineID, r.StationNumericID)
			st, exists := stationByID[id]
			if !exists {
				st = &FullGraphStation{
					ID:            id,
					Title:         r.StationName,
					LineNumericID: r.LineID,
					IsTransfer:    false,
					Lat:           r.Lat,
					Lon:           r.Lng,
				}
				stationByID[id] = st

				// Индекс по имени для маппинга пересадок
				normTitle := normalizeStationName(r.StationName)
				nameMap := lineKeyToStationName[lineKey]
				if nameMap == nil {
					nameMap = make(map[string]string)
					lineKeyToStationName[lineKey] = nameMap
				}
				if _, ok := nameMap[normTitle]; !ok {
					nameMap[normTitle] = id
				}
			}
			stationIDsForLine = append(stationIDsForLine, id)
		}

		lines = append(lines, FullGraphLine{
			ID:         agg.LineID,
			Title:      agg.LineName,
			ColorHex:   "#" + agg.ColorHex,
			StationIDs: stationIDsForLine,
		})

		// Рёбра между соседними станциями
		for i := 0; i < len(stationIDsForLine)-1; i++ {
			fromID := stationIDsForLine[i]
			toID := stationIDsForLine[i+1]
			a := stationByID[fromID]
			b := stationByID[toID]
			travel := estimateTravelSeconds(agg.LineID, a, b)
			edges = append(edges, FullGraphEdge{
				FromStationID:       fromID,
				ToStationID:         toID,
				LineNumericID:       agg.LineID,
				MedianTravelSeconds: travel,
				IsTransfer:          false,
			})
		}

		// Замыкаем кольцевые линии
		if _, isRing := ringLineIDs[agg.LineID]; isRing && len(stationIDsForLine) >= 3 {
			lastID := stationIDsForLine[len(stationIDsForLine)-1]
			firstID := stationIDsForLine[0]
			last := stationByID[lastID]
			first := stationByID[firstID]
			travel := estimateTravelSeconds(agg.LineID, last, first)
			edges = append(edges, FullGraphEdge{
				FromStationID:       lastID,
				ToStationID:         firstID,
				LineNumericID:       agg.LineID,
				MedianTravelSeconds: travel,
				IsTransfer:          false,
			})
		}
	}

	// Если загружены координаты со схемы Яндекса — проставляем их на станции по нормализованному имени.
	if len(yandexByName) > 0 {
		for _, st := range stationByID {
			nameNorm := normalizeStationName(st.Title)
			entries := yandexByName[nameNorm]
			if len(entries) == 0 {
				continue
			}
			// Если совпадений несколько (одинаковое имя в разных местах), берём первую.
			st.YandexX = entries[0].X
			st.YandexY = entries[0].Y
		}
	}

	// Пересадки и хабы
	transferHubs, transferEdges := buildTransferHubs(absConn, lineKeyToStationName, stationByID)
	edges = append(edges, transferEdges...)

	// Собираем итоговый граф
	stations := make([]FullGraphStation, 0, len(stationByID))
	for _, st := range stationByID {
		stations = append(stations, *st)
	}

	return FullGraphExport{
		Lines:        lines,
		Stations:     stations,
		Edges:        edges,
		TransferHubs: transferHubs,
	}, nil
}

// resolvePath интерпретирует путь относительно корня проекта, если он относительный.
func resolvePath(p string) (string, error) {
	if filepath.IsAbs(p) {
		return p, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, p), nil
}

func loadCSVRows(csvPath string) ([]csvRow, error) {
	f, err := os.Open(csvPath)
	if err != nil {
		return nil, fmt.Errorf("open csv: %w", err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	r.ReuseRecord = true

	headers, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	idx := func(name string) int {
		for i, h := range headers {
			if h == name {
				return i
			}
		}
		return -1
	}

	idxCityID := idx("city_id")
	idxCityName := idx("city_name")
	idxLineID := idx("line_id")
	idxLineName := idx("line_name")
	idxLineColor := idx("line_hex_color")
	idxStationID := idx("station_id")
	idxStationName := idx("station_name")
	idxLat := idx("lat")
	idxLng := idx("lng")
	idxOrder := idx("order")

	for _, v := range []int{idxCityID, idxCityName, idxLineID, idxLineName, idxLineColor, idxStationID, idxStationName, idxLat, idxLng, idxOrder} {
		if v == -1 {
			return nil, fmt.Errorf("metro.ru.csv: unexpected header format")
		}
	}

	var rows []csvRow
	for {
		rec, err := r.Read()
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return nil, fmt.Errorf("read row: %w", err)
		}
		if len(rec) <= idxOrder {
			continue
		}

		cityNameRaw := strings.Trim(rec[idxCityName], "\"")
		if cityNameRaw != targetCityName {
			continue
		}

		lineNameRaw := strings.Trim(rec[idxLineName], "\"")
		if mcdRe.MatchString(lineNameRaw) { // пропускаем МЦД
			continue
		}

		cityID, _ := strconv.Atoi(rec[idxCityID])
		lineID, _ := strconv.Atoi(rec[idxLineID])
		stationIDStr := rec[idxStationID]
		stationNameRaw := strings.Trim(rec[idxStationName], "\"")
		lat, _ := strconv.ParseFloat(rec[idxLat], 64)
		lng, _ := strconv.ParseFloat(rec[idxLng], 64)
		order, _ := strconv.Atoi(rec[idxOrder])
		colorHexRaw := rec[idxLineColor]

		if !isFinite(lat) || !isFinite(lng) {
			continue
		}

		rows = append(rows, csvRow{
			CityID:           cityID,
			CityName:         cityNameRaw,
			LineID:           lineID,
			LineName:         lineNameRaw,
			LineColorHex:     colorHexRaw,
			StationNumericID: stationIDStr,
			StationName:      stationNameRaw,
			Lat:              lat,
			Lng:              lng,
			Order:            order,
		})
	}

	return rows, nil
}

type lineAggregate struct {
	LineID   int
	LineName string
	ColorHex string
	Rows     []csvRow
}

func groupRowsByLine(rows []csvRow) map[int]*lineAggregate {
	res := make(map[int]*lineAggregate)
	for _, r := range rows {
		agg := res[r.LineID]
		if agg == nil {
			agg = &lineAggregate{LineID: r.LineID, LineName: r.LineName, ColorHex: r.LineColorHex}
			res[r.LineID] = agg
		}
		agg.Rows = append(agg.Rows, r)
	}
	return res
}

func estimateTravelSeconds(lineID int, a, b *FullGraphStation) int {
	if a == nil || b == nil {
		return 120
	}
	if !isFinite(a.Lat) || !isFinite(a.Lon) || !isFinite(b.Lat) || !isFinite(b.Lon) {
		return 120
	}
	distKm := haversineDistanceKm(a.Lat, a.Lon, b.Lat, b.Lon)
	if distKm <= 0 {
		return minTravelSeconds
	}

	// Базовая модель: константное время на старт/остановку поезда
	// плюс время хода, зависящее от типа линии.
	speedKmH := float64(avgTrainSpeedKmH)
	if _, isRing := ringLineIDs[lineID]; isRing {
		switch lineID {
		case 5:
			// Кольцевая линия обычно идёт чуть быстрее за счёт малого интервала и
			// относительно ровного профиля движения.
			speedKmH = 42
		case 95:
			// МЦК: пригородное движение с более высокой крейсерской скоростью.
			speedKmH = 45
		case 97:
			// БКЛ: много остановок, оставляем скорость близкой к базовой.
			speedKmH = 40
		default:
			speedKmH = float64(avgTrainSpeedKmH)
		}
	} else {
		// Радиальные линии: считаем чуть медленнее базового значения.
		speedKmH = 38
	}

	runSeconds := (distKm / speedKmH) * 3600.0
	sec := int(math.Round(runSeconds)) + baseRunSeconds
	if sec < minTravelSeconds {
		sec = minTravelSeconds
	}
	return sec
}

func haversineDistanceKm(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0
	toRad := func(deg float64) float64 { return deg * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLon := toRad(lon2 - lon1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

// transferSecondsForType возвращает эвристическое медианное время пересадки
// (в секундах) в зависимости от типа соединения из connections.json.
func transferSecondsForType(connType string) int {
	switch connType {
	case "cross_platform":
		// Пересадка через общую платформу: быстрая.
		return 90
	case "interchange":
		// Обычная пересадка между линиями в одном узле.
		return 210
	case "mcc":
		// Переход метро ↔ МЦК: чуть длиннее обычной пересадки.
		return 270
	case "out-of-station":
		// Уличный переход между станциями/вокзалами.
		return 420
	default:
		return baseTransferSeconds
	}
}

// transferKindForType маппит тип соединения из connections.json в нормализованный
// TransferKind, который используется в TypeScript-части приложения.
// Возможные значения на стороне TS: "near", "far", "out_of_station", "mcc", "mcd", "ignored".
func transferKindForType(connType string) string {
	switch connType {
	case "cross_platform", "interchange":
		// Обычные пересадки внутри хаба.
		return "near"
	case "mcc":
		// Переходы метро ↔ МЦК.
		return "mcc"
	case "out-of-station":
		// Уличные/внестанционные переходы.
		return "out_of_station"
	default:
		return ""
	}
}

// buildTransferHubs читает connections.json, строит пересадочные хабы и рёбра пересадок.
func buildTransferHubs(connPath string, lineKeyToStation map[string]map[string]string, stationByID map[string]*FullGraphStation) ([]FullGraphTransferHub, []FullGraphEdge) {
	absConn, err := resolvePath(connPath)
	if err != nil {
		return nil, nil
	}

	data, err := os.ReadFile(absConn)
	if err != nil {
		return nil, nil
	}

	var conns []connectionRecord
	if err := json.Unmarshal(data, &conns); err != nil {
		return nil, nil
	}

	adj := make(map[string]map[string]struct{})
	edgeKeySet := make(map[string]struct{})
	var transferEdges []FullGraphEdge

	edgeKey := func(a, b string) string {
		if a < b {
			return a + "|" + b
		}
		return b + "|" + a
	}

	addAdj := func(a, b string) {
		m := adj[a]
		if m == nil {
			m = make(map[string]struct{})
			adj[a] = m
		}
		m[b] = struct{}{}
	}

	for _, c := range conns {
		if _, ok := allowedConnectionTypes[c.Type]; !ok {
			continue
		}

		fromLineKey := normalizeLineKeyFromConnection(c.FromLine)
		toLineKey := normalizeLineKeyFromConnection(c.ToLine)
		if fromLineKey == "" || toLineKey == "" {
			continue
		}

		fromNameNorm := normalizeStationName(c.FromStation)
		toNameNorm := normalizeStationName(c.ToStation)

		fromByName := lineKeyToStation[fromLineKey]
		toByName := lineKeyToStation[toLineKey]
		if fromByName == nil || toByName == nil {
			continue
		}

		fromID := fromByName[fromNameNorm]
		toID := toByName[toNameNorm]
		if fromID == "" || toID == "" || fromID == toID {
			continue
		}

		// Длинные пересадки out-of-station не должны схлопываться в один хаб.
		// Для них создаём только рёбра, но не добавляем их в adjacency компонент.
		isOutOfStation := c.Type == "out-of-station"
		if !isOutOfStation {
			addAdj(fromID, toID)
			addAdj(toID, fromID)
		}

		k := edgeKey(fromID, toID)
		if _, exists := edgeKeySet[k]; !exists {
			edgeKeySet[k] = struct{}{}
			transferSeconds := transferSecondsForType(c.Type)
			kind := transferKindForType(c.Type)
			transferEdges = append(transferEdges, FullGraphEdge{
				FromStationID:       fromID,
				ToStationID:         toID,
				MedianTravelSeconds: transferSeconds,
				IsTransfer:          true,
				TransferKind:        kind,
			})
		}
	}

	var hubs []FullGraphTransferHub
	visited := make(map[string]struct{})

	for start := range adj {
		if _, ok := visited[start]; ok {
			continue
		}
		queue := []string{start}
		component := make([]string, 0, 4)
		visited[start] = struct{}{}

		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			component = append(component, cur)
			for nxt := range adj[cur] {
				if _, ok := visited[nxt]; !ok {
					visited[nxt] = struct{}{}
					queue = append(queue, nxt)
				}
			}
		}

		if len(component) >= 2 {
			id := fmt.Sprintf("hub-%d", len(hubs)+1)
			hubs = append(hubs, FullGraphTransferHub{
				ID:                 id,
				StationIDs:         append([]string{}, component...),
				MinTransferSeconds: baseTransferSeconds,
				Source:             "manual_override",
			})
			for _, sid := range component {
				if st := stationByID[sid]; st != nil {
					st.IsTransfer = true
					st.HubID = id
				}
			}
		}
	}

	// Дополнительно помечаем как пересадочные все станции, которые участвуют
	// в любых рёбрах-пересадках (включая out-of-station), даже если они не
	// входят ни в один компактный хаб. Это нужно, чтобы, например, станция
	// «Войковская» отображалась как пересадочная при длинных переходах.
	for _, e := range transferEdges {
		if st := stationByID[e.FromStationID]; st != nil {
			st.IsTransfer = true
		}
		if st := stationByID[e.ToStationID]; st != nil {
			st.IsTransfer = true
		}
	}

	// Для всех оставшихся пересадочных станций без HubID создаём одиночные хабы,
	// чтобы каждая пересадка имела hubId. Это важно для единообразной обработки
	// пересадок на уровне layout и UI (группировка подписей, анализ компактности).
	for _, st := range stationByID {
		if !st.IsTransfer || st.HubID != "" {
			continue
		}
		id := fmt.Sprintf("hub-%d", len(hubs)+1)
		hubs = append(hubs, FullGraphTransferHub{
			ID:                 id,
			StationIDs:         []string{st.ID},
			MinTransferSeconds: baseTransferSeconds,
			Source:             "single_transfer",
		})
		st.HubID = id
	}

	return hubs, transferEdges
}

// --- Нормализация имён линий и станций ---

func normalizeStationName(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, "ё", "е")
	repl := []string{"«", "»", "\"", "\u201e"}
	for _, r := range repl {
		s = strings.ReplaceAll(s, r, " ")
	}
	s = strings.ReplaceAll(s, ".", " ")
	s = strings.ReplaceAll(s, " - ", "-") // collapse spaces around hyphens
	// убираем "им." / "имени"
	s = regexp.MustCompile(`\bим\.?\b`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\bимени\b`).ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func normalizeLineKeyFromCSV(name string) string {
	s := strings.TrimSpace(name)
	s = strings.ReplaceAll(s, "ё", "е")
	s = regexp.MustCompile(`\s+линия$`).ReplaceAllString(s, "")
	if i := strings.Index(s, "/"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	return s
}

// isFinite возвращает true, если число конечно (не NaN и не бесконечность).
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func normalizeLineKeyFromConnection(name string) string {
	s := strings.TrimSpace(name)
	if s == "" {
		return ""
	}
	if mcdRe.MatchString(s) {
		return "" // МЦД игнорируем
	}
	s = strings.ReplaceAll(s, "ё", "е")
	if i := strings.Index(s, "("); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	s = regexp.MustCompile(`\s+линия$`).ReplaceAllString(s, "")
	if i := strings.Index(s, "/"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	return s
}
