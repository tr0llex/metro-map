// Чтение схемы из каталога `data/` — единственного источника истины.
//
// Раньше вход был другим: дамп `metro.ru.csv` по всем городам России плюс
// `connections.json`, где пересадки ссылались на станции ТЕКСТОМ («Библиотека
// им.Ленина» на «Арбатско-Покровская линия»). Отсюда рос целый слой нормализации
// имён и индексов «линия -> станция по имени», а поверх результата ещё
// накладывались оверрайды координат, времён и названий. Править вход стало
// нельзя: настоящие данные жили в результате сборки, а не во входе.
//
// Теперь станции и пересадки связаны идентификаторами, а не именами, поэтому
// сопоставление по именам исчезло целиком. Взамен появилась проверка входа:
// данные правятся руками, и любая опечатка обязана останавливать сборку с
// внятным сообщением, а не молча выбрасывать станцию из схемы.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// --- Public graph types exported to JSON ---

type FullGraphLine struct {
	ID       int    `json:"id"`
	Title    string `json:"title"`
	ColorHex string `json:"colorHex"`
	// StationIDs — ПРИНАДЛЕЖНОСТЬ: все станции линии. Соседство по этому списку
	// выводить нельзя: ответвления идут в конец, и последняя станция основного
	// хода оказывается «соседом» первой станции ветки.
	StationIDs []string `json:"stationIds"`
	// Segments — ходы линии: сначала основной, затем по одному на ответвление.
	// Ветка начинается со станции, от которой отходит, чтобы полилиния была
	// связной, а соседство внутри сегмента можно было брать подряд.
	Segments [][]string `json:"segments"`
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
}

// FullGraphRingShape — аналитическая форма кольцевой линии.
// Ровно два варианта Kind: "circle" (Cx, Cy, R) и "ellipse" (Cx, Cy, Rx, Ry).
// Координаты станций кольцевой линии в этом же файле лежат ровно на этой форме.
type FullGraphRingShape struct {
	Kind string   `json:"kind"`
	Cx   float64  `json:"cx"`
	Cy   float64  `json:"cy"`
	R    *float64 `json:"r,omitempty"`
	Rx   *float64 `json:"rx,omitempty"`
	Ry   *float64 `json:"ry,omitempty"`
}

type FullGraphExport struct {
	Lines        []FullGraphLine        `json:"lines"`
	Stations     []FullGraphStation     `json:"stations"`
	Edges        []FullGraphEdge        `json:"edges"`
	TransferHubs []FullGraphTransferHub `json:"transferHubs"`
	// RingShapes — карта "id линии (строкой)" -> форма кольца. Поле опциональное:
	// некольцевых линий в карте нет.
	RingShapes map[string]FullGraphRingShape `json:"ringShapes,omitempty"`
}

// --- Формат каталога data/ ---

// dataStation — станция в файле линии (data/lines/*.json).
// ToNextSeconds — время до СЛЕДУЮЩЕЙ станции в списке; у последней станции
// некольцевой линии его нет, у последней станции кольцевой — это время до первой.
type dataStation struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Lat           *float64 `json:"lat"`
	Lon           *float64 `json:"lon"`
	ToNextSeconds *int     `json:"toNextSeconds"`
}

// dataBranch — ответвление линии: цепочка станций, отходящая от станции From.
//
// Нужно потому, что линия не всегда простой путь. У Филёвской ветка на
// «Москва-Сити» отходит от «Киевской», а основной ход идёт до «Александровского
// сада». Пока линия описывалась одним плоским списком, ветка неизбежно
// пришивалась к последней станции списка — и маршруты через неё считались
// неверно.
type dataBranch struct {
	Title string `json:"title"`
	// From — станция ЭТОЙ ЖЕ линии, от которой отходит ветка.
	From string `json:"from"`
	// FromSeconds — время от From до первой станции ветки.
	FromSeconds *int          `json:"fromSeconds"`
	Stations    []dataStation `json:"stations"`
}

type dataLine struct {
	ID       int           `json:"id"`
	Title    string        `json:"title"`
	Color    string        `json:"color"`
	Ring     bool          `json:"ring"`
	Stations []dataStation `json:"stations"`
	Branches []dataBranch  `json:"branches"`
}

type dataTransfer struct {
	Stations []string `json:"stations"`
	Kind     string   `json:"kind"`
	Seconds  *int     `json:"seconds"`
}

type dataTransfersFile struct {
	Defaults struct {
		RideSeconds   int            `json:"rideSeconds"`
		HubMinSeconds int            `json:"hubMinSeconds"`
		KindSeconds   map[string]int `json:"kindSeconds"`
	} `json:"defaults"`
	Transfers []dataTransfer `json:"transfers"`
}

type dataLayoutFile struct {
	Stations map[string][]float64          `json:"stations"`
	Rings    map[string]FullGraphRingShape `json:"rings"`
}

// ringLineIDs заполняется при загрузке из флага `ring` в файлах линий.
// Читается в rings.go: кольцевые линии проецируются на подогнанную форму.
var ringLineIDs = map[int]struct{}{}

// transferKinds — типы пересадок, которые понимает рантайм (src/metro/types.ts).
// Незнакомый тип — ошибка сборки, а не молчаливое приведение к "near":
// опечатка в типе меняет и время пересадки, и отрисовку узла.
var transferKinds = map[string]struct{}{
	"near":           {},
	"far":            {},
	"mcc":            {},
	"out_of_station": {},
}

// BuildFullGraph читает каталог data/ и собирает полный граф.
//
// Времена перегонов и пересадок берутся ТОЛЬКО из данных (toNextSeconds у
// станции, seconds у пересадки либо значение по умолчанию для её типа). Оценки
// по географическому расстоянию больше нет: она давала правдоподобные числа
// там, где данных на самом деле не было, и отличить одно от другого было никак.
func BuildFullGraph(dataDir string) (FullGraphExport, error) {
	root, err := resolvePath(dataDir)
	if err != nil {
		return FullGraphExport{}, err
	}

	lines, err := loadDataLines(filepath.Join(root, "lines"))
	if err != nil {
		return FullGraphExport{}, err
	}

	var transfersFile dataTransfersFile
	if err := readJSONFile(filepath.Join(root, "transfers.json"), &transfersFile); err != nil {
		return FullGraphExport{}, err
	}
	if transfersFile.Defaults.RideSeconds <= 0 {
		return FullGraphExport{}, fmt.Errorf("transfers.json: defaults.rideSeconds должен быть больше нуля")
	}
	if transfersFile.Defaults.HubMinSeconds <= 0 {
		return FullGraphExport{}, fmt.Errorf("transfers.json: defaults.hubMinSeconds должен быть больше нуля")
	}

	var layoutFile dataLayoutFile
	if err := readJSONFile(filepath.Join(root, "layout.json"), &layoutFile); err != nil {
		return FullGraphExport{}, err
	}

	stationByID := make(map[string]*FullGraphStation)
	lineOfStation := make(map[string]int)
	outLines := make([]FullGraphLine, 0, len(lines))
	var edges []FullGraphEdge

	for _, ln := range lines {
		if ln.Ring {
			ringLineIDs[ln.ID] = struct{}{}
		}

		lineEdges, ids, segments, err := buildLine(ln, transfersFile.Defaults.RideSeconds, stationByID, lineOfStation)
		if err != nil {
			return FullGraphExport{}, err
		}
		edges = append(edges, lineEdges...)
		outLines = append(outLines, FullGraphLine{
			ID:         ln.ID,
			Title:      ln.Title,
			ColorHex:   ln.Color,
			StationIDs: ids,
			Segments:   segments,
		})
	}

	hubs, transferEdges, err := buildTransfers(transfersFile, stationByID, lineOfStation)
	if err != nil {
		return FullGraphExport{}, err
	}
	edges = append(edges, transferEdges...)

	if err := applyLayout(layoutFile, stationByID); err != nil {
		return FullGraphExport{}, err
	}

	// Порядок станций в выгрузке детерминирован: обход map даёт случайный.
	ordered := make([]string, 0, len(stationByID))
	for id := range stationByID {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	stations := make([]FullGraphStation, 0, len(ordered))
	for _, id := range ordered {
		stations = append(stations, *stationByID[id])
	}

	return FullGraphExport{
		Lines:        outLines,
		Stations:     stations,
		Edges:        edges,
		TransferHubs: hubs,
		RingShapes:   layoutFile.Rings,
	}, nil
}

// buildLine раскладывает одну линию в станции и перегоны, включая ответвления.
// Возвращает рёбра и полный список идентификаторов станций линии (основной ход,
// затем ветки в порядке объявления).
func buildLine(
	ln dataLine,
	defaultRideSeconds int,
	stationByID map[string]*FullGraphStation,
	lineOfStation map[string]int,
) ([]FullGraphEdge, []string, [][]string, error) {
	var edges []FullGraphEdge
	ids := make([]string, 0, len(ln.Stations))

	register := func(st dataStation, pos string) error {
		if strings.TrimSpace(st.ID) == "" {
			return fmt.Errorf("линия %d: у станции %s пустой id", ln.ID, pos)
		}
		if strings.TrimSpace(st.Title) == "" {
			return fmt.Errorf("линия %d: у станции %s пустое название", ln.ID, st.ID)
		}
		if prev, dup := stationByID[st.ID]; dup {
			return fmt.Errorf("дубль идентификатора станции %s: %q (линия %d) и %q (линия %d)",
				st.ID, prev.Title, prev.LineNumericID, st.Title, ln.ID)
		}
		s := &FullGraphStation{ID: st.ID, Title: st.Title, LineNumericID: ln.ID}
		if st.Lat != nil {
			s.Lat = *st.Lat
		}
		if st.Lon != nil {
			s.Lon = *st.Lon
		}
		stationByID[st.ID] = s
		lineOfStation[st.ID] = ln.ID
		ids = append(ids, st.ID)
		return nil
	}

	rideSeconds := func(v *int) int {
		if v != nil {
			return *v
		}
		return defaultRideSeconds
	}

	addEdge := func(from, to string, seconds int) error {
		if seconds <= 0 {
			return fmt.Errorf("линия %d: перегон %s -> %s имеет время %d с", ln.ID, from, to, seconds)
		}
		edges = append(edges, FullGraphEdge{
			FromStationID:       from,
			ToStationID:         to,
			LineNumericID:       ln.ID,
			MedianTravelSeconds: seconds,
		})
		return nil
	}

	for i, st := range ln.Stations {
		if err := register(st, fmt.Sprintf("№%d (%q)", i+1, st.Title)); err != nil {
			return nil, nil, nil, err
		}
	}
	if len(ids) < 2 {
		return nil, nil, nil, fmt.Errorf("линия %d (%s): станций %d, нужно минимум 2", ln.ID, ln.Title, len(ids))
	}

	last := len(ln.Stations) - 1
	for i, st := range ln.Stations {
		switch {
		case i < last:
			if err := addEdge(st.ID, ids[i+1], rideSeconds(st.ToNextSeconds)); err != nil {
				return nil, nil, nil, err
			}
		case ln.Ring:
			if err := addEdge(st.ID, ids[0], rideSeconds(st.ToNextSeconds)); err != nil {
				return nil, nil, nil, err
			}
		case st.ToNextSeconds != nil:
			return nil, nil, nil, fmt.Errorf(
				"линия %d (%s): у конечной станции %s задан toNextSeconds, но следующей станции нет; для замыкания в кольцо нужен \"ring\": true",
				ln.ID, ln.Title, st.ID)
		}
	}

	if len(ln.Branches) > 0 && ln.Ring {
		return nil, nil, nil, fmt.Errorf("линия %d (%s): у кольцевой линии не может быть ответвлений", ln.ID, ln.Title)
	}

	for bi, br := range ln.Branches {
		where := fmt.Sprintf("линия %d, ответвление №%d", ln.ID, bi+1)
		if len(br.Stations) == 0 {
			return nil, nil, nil, fmt.Errorf("%s: нет ни одной станции", where)
		}
		if _, ok := stationByID[br.From]; !ok {
			return nil, nil, nil, fmt.Errorf("%s: станции %s, от которой оно отходит, нет", where, br.From)
		}
		if lineOfStation[br.From] != ln.ID {
			return nil, nil, nil, fmt.Errorf("%s: станция %s принадлежит линии %d, а не %d",
				where, br.From, lineOfStation[br.From], ln.ID)
		}

		firstIdx := len(ids)
		for i, st := range br.Stations {
			if err := register(st, fmt.Sprintf("№%d ветки %q", i+1, br.Title)); err != nil {
				return nil, nil, nil, err
			}
		}

		if err := addEdge(br.From, ids[firstIdx], rideSeconds(br.FromSeconds)); err != nil {
			return nil, nil, nil, err
		}
		blast := len(br.Stations) - 1
		for i, st := range br.Stations {
			if i < blast {
				if err := addEdge(st.ID, ids[firstIdx+i+1], rideSeconds(st.ToNextSeconds)); err != nil {
					return nil, nil, nil, err
				}
			} else if st.ToNextSeconds != nil {
				return nil, nil, nil, fmt.Errorf("%s: у конечной станции %s задан toNextSeconds, но следующей станции нет",
					where, st.ID)
			}
		}
	}

	segments := [][]string{append([]string{}, ids[:len(ln.Stations)]...)}
	pos := len(ln.Stations)
	for _, br := range ln.Branches {
		seg := append([]string{br.From}, ids[pos:pos+len(br.Stations)]...)
		segments = append(segments, seg)
		pos += len(br.Stations)
	}

	return edges, ids, segments, nil
}

// loadDataLines читает data/lines/*.json.
//
// Порядок линий определяет и порядок в выгрузке, и порядок отрисовки в рантайме:
// кольцевые идут первыми (рисуются под остальными), дальше — по возрастанию id.
// Он задаётся здесь явно, а не именами файлов: переименование файла не должно
// менять картинку.
func loadDataLines(dir string) ([]dataLine, error) {
	names, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, fmt.Errorf("поиск файлов линий в %s: %w", dir, err)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("в %s нет ни одного файла линии", dir)
	}
	sort.Strings(names)

	lines := make([]dataLine, 0, len(names))
	seen := make(map[int]string)
	for _, name := range names {
		var ln dataLine
		if err := readJSONFile(name, &ln); err != nil {
			return nil, err
		}
		base := filepath.Base(name)
		if ln.ID <= 0 {
			return nil, fmt.Errorf("%s: не задан id линии", base)
		}
		if prev, dup := seen[ln.ID]; dup {
			return nil, fmt.Errorf("id линии %d встречается дважды: %s и %s", ln.ID, prev, base)
		}
		if !strings.HasPrefix(ln.Color, "#") || (len(ln.Color) != 7 && len(ln.Color) != 4) {
			return nil, fmt.Errorf("%s: цвет %q не в формате #RRGGBB", base, ln.Color)
		}
		seen[ln.ID] = base
		lines = append(lines, ln)
	}

	sort.SliceStable(lines, func(i, j int) bool {
		if lines[i].Ring != lines[j].Ring {
			return lines[i].Ring
		}
		return lines[i].ID < lines[j].ID
	})
	return lines, nil
}

// buildTransfers строит рёбра пересадок и пересадочные узлы (хабы).
//
// Хабы в данных не хранятся: узел — это связная компонента списка пересадок.
// Хранить их отдельно значило бы держать два описания одного факта, которые
// разъезжаются при первой же правке.
func buildTransfers(
	file dataTransfersFile,
	stationByID map[string]*FullGraphStation,
	lineOfStation map[string]int,
) ([]FullGraphTransferHub, []FullGraphEdge, error) {
	adj := make(map[string]map[string]struct{})
	seenPair := make(map[string]struct{})
	var edges []FullGraphEdge

	pairKey := func(a, b string) string {
		if a < b {
			return a + "|" + b
		}
		return b + "|" + a
	}

	for i, t := range file.Transfers {
		where := fmt.Sprintf("transfers.json, пересадка №%d", i+1)
		if len(t.Stations) != 2 {
			return nil, nil, fmt.Errorf("%s: в stations должно быть ровно 2 станции, а их %d", where, len(t.Stations))
		}
		a, b := t.Stations[0], t.Stations[1]
		if _, ok := stationByID[a]; !ok {
			return nil, nil, fmt.Errorf("%s: станции %s нет ни на одной линии", where, a)
		}
		if _, ok := stationByID[b]; !ok {
			return nil, nil, fmt.Errorf("%s: станции %s нет ни на одной линии", where, b)
		}
		if lineOfStation[a] == lineOfStation[b] {
			return nil, nil, fmt.Errorf("%s: %s и %s на одной линии %d — это перегон, а не пересадка",
				where, a, b, lineOfStation[a])
		}
		if _, ok := transferKinds[t.Kind]; !ok {
			return nil, nil, fmt.Errorf("%s: неизвестный тип %q (допустимые: far, mcc, near, out_of_station)", where, t.Kind)
		}

		key := pairKey(a, b)
		if _, dup := seenPair[key]; dup {
			return nil, nil, fmt.Errorf("%s: пересадка %s <-> %s описана дважды", where, a, b)
		}
		seenPair[key] = struct{}{}

		seconds, ok := file.Defaults.KindSeconds[t.Kind]
		if !ok {
			return nil, nil, fmt.Errorf("%s: для типа %q нет значения в defaults.kindSeconds", where, t.Kind)
		}
		if t.Seconds != nil {
			seconds = *t.Seconds
		}
		if seconds <= 0 {
			return nil, nil, fmt.Errorf("%s: время пересадки %d с", where, seconds)
		}

		// Уличные переходы не схлопываются в общий узел: это две разные станции,
		// между которыми надо выйти в город, а не один пересадочный узел.
		if t.Kind != "out_of_station" {
			if adj[a] == nil {
				adj[a] = make(map[string]struct{})
			}
			if adj[b] == nil {
				adj[b] = make(map[string]struct{})
			}
			adj[a][b] = struct{}{}
			adj[b][a] = struct{}{}
		}

		edges = append(edges, FullGraphEdge{
			FromStationID:       a,
			ToStationID:         b,
			MedianTravelSeconds: seconds,
			IsTransfer:          true,
			TransferKind:        t.Kind,
		})
	}

	// Компоненты связности -> хабы. Обход по отсортированным ключам: номера
	// хабов и порядок станций внутри не должны зависеть от обхода map.
	starts := make([]string, 0, len(adj))
	for id := range adj {
		starts = append(starts, id)
	}
	sort.Strings(starts)

	var hubs []FullGraphTransferHub
	visited := make(map[string]struct{})

	for _, start := range starts {
		if _, ok := visited[start]; ok {
			continue
		}
		queue := []string{start}
		visited[start] = struct{}{}
		component := make([]string, 0, 4)

		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			component = append(component, cur)

			nexts := make([]string, 0, len(adj[cur]))
			for nxt := range adj[cur] {
				nexts = append(nexts, nxt)
			}
			sort.Strings(nexts)
			for _, nxt := range nexts {
				if _, ok := visited[nxt]; ok {
					continue
				}
				visited[nxt] = struct{}{}
				queue = append(queue, nxt)
			}
		}

		// Хаб из одной станции пересадки не даёт, но рисуется как узел —
		// таких не создаём. При out_of_station станция остаётся без hubId,
		// сама пересадка живёт в ребре.
		if len(component) < 2 {
			continue
		}
		sort.Strings(component)
		id := fmt.Sprintf("hub-%d", len(hubs)+1)
		hubs = append(hubs, FullGraphTransferHub{
			ID:                 id,
			StationIDs:         component,
			MinTransferSeconds: file.Defaults.HubMinSeconds,
			Source:             "data",
		})
		for _, sid := range component {
			stationByID[sid].IsTransfer = true
			stationByID[sid].HubID = id
		}
	}

	// Станция с уличным переходом тоже пересадочная, хотя хаба у неё нет.
	for _, e := range edges {
		stationByID[e.FromStationID].IsTransfer = true
		stationByID[e.ToStationID].IsTransfer = true
	}

	return hubs, edges, nil
}

// applyLayout проставляет координаты схемы.
//
// Станция без координат просто не рисуется, а лишняя запись означает, что
// станцию переименовали или удалили и забыли про раскладку. И то и другое —
// ошибка сборки: молча получить схему с дырой хуже, чем не собрать её вовсе.
func applyLayout(file dataLayoutFile, stationByID map[string]*FullGraphStation) error {
	var missing, extra []string

	for id, xy := range file.Stations {
		st, ok := stationByID[id]
		if !ok {
			extra = append(extra, id)
			continue
		}
		if len(xy) != 2 || !isFinite(xy[0]) || !isFinite(xy[1]) {
			return fmt.Errorf("layout.json: у станции %s координаты должны быть [x, y], а там %v", id, xy)
		}
		st.LayoutX = xy[0]
		st.LayoutY = xy[1]
	}

	for id := range stationByID {
		if _, ok := file.Stations[id]; !ok {
			missing = append(missing, id)
		}
	}

	sort.Strings(missing)
	sort.Strings(extra)

	if len(missing) > 0 {
		return fmt.Errorf("layout.json: нет координат у %d станций: %s\n"+
			"Добавьте их в data/layout.json (или расставьте в редакторе: npm run dev:editor)",
			len(missing), strings.Join(missing, ", "))
	}
	if len(extra) > 0 {
		return fmt.Errorf("layout.json: координаты заданы для %d несуществующих станций: %s\n"+
			"Станцию переименовали или удалили — уберите запись из data/layout.json",
			len(extra), strings.Join(extra, ", "))
	}

	for key := range file.Rings {
		id, err := strconv.Atoi(key)
		if err != nil {
			return fmt.Errorf("layout.json: ключ rings.%q — не номер линии", key)
		}
		if _, ok := ringLineIDs[id]; !ok {
			return fmt.Errorf("layout.json: rings.%s задаёт форму кольца для линии %d, а она не кольцевая", key, id)
		}
	}

	return nil
}

// ringShapeOverrides переводит формы колец из data/layout.json во внутренний вид
// для rings.go. Пустая карта означает автоподгонку формы по координатам станций.
func ringShapeOverrides(shapes map[string]FullGraphRingShape) map[int]ringShape {
	if len(shapes) == 0 {
		return nil
	}
	out := make(map[int]ringShape, len(shapes))
	for key, s := range shapes {
		id, err := strconv.Atoi(key)
		if err != nil {
			continue
		}
		v := ringShape{kind: s.Kind, cx: s.Cx, cy: s.Cy}
		if s.R != nil {
			v.r = *s.R
		}
		if s.Rx != nil {
			v.rx = *s.Rx
		}
		if s.Ry != nil {
			v.ry = *s.Ry
		}
		out[id] = v
	}
	return out
}

// --- Мелкие помощники ---

func readJSONFile(path string, dst any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("чтение %s: %w", path, err)
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return fmt.Errorf("разбор %s: %w", path, err)
	}
	return nil
}

// resolvePath интерпретирует путь относительно рабочего каталога, если он относительный.
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

// isFinite возвращает true, если число конечно (не NaN и не бесконечность).
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
