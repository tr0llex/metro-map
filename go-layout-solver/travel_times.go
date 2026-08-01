// Времена перегонов и пересадок — из конфига, а не из геометрии.
//
// Источник правды: new_map_source/travel_times.json (флаг -travel_times).
// Владелец правит файл руками/через админку; солвер только читает его.
// НИКАКОЙ геометрии: координаты станций в расчёте времени не участвуют.
// Старая оценка по haversine (estimateTravelSeconds) остаётся только как
// запасной путь на случай, когда конфиг не передан или не читается.
//
// Ключ пары — два id станции через "|", отсортированные по алфавиту: та же
// конвенция, что у undirectedEdgeKey на стороне TS.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
)

// travelTimeEntry — одна запись конфига. Поле stations справочное: оно нужно,
// чтобы файл читался руками, и на расчёт не влияет.
type travelTimeEntry struct {
	Seconds  *int   `json:"seconds"`
	Kind     string `json:"kind,omitempty"`
	Stations string `json:"stations,omitempty"`
}

type travelTimeDefaults struct {
	RideSeconds           int            `json:"rideSeconds"`
	TransferSeconds       map[string]int `json:"transferSeconds"`
	HubMinTransferSeconds int            `json:"hubMinTransferSeconds"`
}

// TravelTimes — прочитанный конфиг времён плюс статистика применения:
// какие ключи так и не совпали ни с одним ребром графа и сколько рёбер
// поехало на дефолтах. И то и другое печатается сводкой после сборки —
// иначе расхождение конфига с данными остаётся незамеченным.
type TravelTimes struct {
	Defaults  travelTimeDefaults         `json:"defaults"`
	Rides     map[string]travelTimeEntry `json:"rides"`
	Transfers map[string]travelTimeEntry `json:"transfers"`

	usedRides        map[string]struct{}
	usedTransfers    map[string]struct{}
	rideDefaults     int
	rideFromConfig   int
	transDefaults    int
	transFromConfig  int
	unknownKinds     map[string]int
	kindMismatches   []string
	badSecondsKeys   []string
	hubMinFromConfig bool
}

const (
	fallbackRideSeconds = 150
)

// pairKey — ключ пары станций конфига: id через "|", лексикографически.
func pairKey(a, b string) string {
	if a < b {
		return a + "|" + b
	}
	return b + "|" + a
}

// loadTravelTimes читает конфиг времён. Отсутствие файла — не ошибка: солвер
// в этом случае работает как раньше (см. вызов в main.go).
func loadTravelTimes(path string) (*TravelTimes, error) {
	abs, err := resolvePath(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	var t TravelTimes
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("decode travel times json: %w", err)
	}
	t.usedRides = make(map[string]struct{}, len(t.Rides))
	t.usedTransfers = make(map[string]struct{}, len(t.Transfers))
	t.unknownKinds = make(map[string]int)
	if t.Defaults.RideSeconds <= 0 {
		t.Defaults.RideSeconds = fallbackRideSeconds
	}
	if t.Defaults.HubMinTransferSeconds <= 0 {
		t.Defaults.HubMinTransferSeconds = baseTransferSeconds
	} else {
		t.hubMinFromConfig = true
	}
	return &t, nil
}

// seconds достаёт значение из записи. Второе значение — false, если записи нет
// или в ней нет положительного seconds (такой ключ уедет на дефолт и попадёт
// в сводку).
func (t *TravelTimes) seconds(m map[string]travelTimeEntry, used map[string]struct{}, key string) (int, bool) {
	e, ok := m[key]
	if !ok {
		return 0, false
	}
	// Ключ совпал с ребром — он не «лишний», даже если значение негодное.
	// Иначе одна и та же запись попадёт сразу в два разных предупреждения.
	used[key] = struct{}{}
	if e.Seconds == nil || *e.Seconds <= 0 {
		t.badSecondsKeys = append(t.badSecondsKeys, key)
		return 0, false
	}
	return *e.Seconds, true
}

// RideSeconds — время перегона между соседними станциями одной линии.
func (t *TravelTimes) RideSeconds(fromID, toID string) int {
	key := pairKey(fromID, toID)
	if sec, ok := t.seconds(t.Rides, t.usedRides, key); ok {
		t.rideFromConfig++
		return sec
	}
	t.rideDefaults++
	return t.Defaults.RideSeconds
}

// TransferSeconds — время пересадки. Тип пересадки берётся из графа
// (connections.json), конфиг задаёт только длительность; kind в конфиге
// справочный и при расхождении лишь попадает в предупреждения.
func (t *TravelTimes) TransferSeconds(fromID, toID, kind string) int {
	key := pairKey(fromID, toID)
	if e, ok := t.Transfers[key]; ok && e.Kind != "" && kind != "" && e.Kind != kind {
		t.kindMismatches = append(t.kindMismatches,
			fmt.Sprintf("%s: в конфиге kind=%q, в графе %q", key, e.Kind, kind))
	}
	if sec, ok := t.seconds(t.Transfers, t.usedTransfers, key); ok {
		t.transFromConfig++
		return sec
	}
	t.transDefaults++
	if sec, ok := t.Defaults.TransferSeconds[kind]; ok && sec > 0 {
		return sec
	}
	if kind != "" {
		t.unknownKinds[kind]++
	}
	return baseTransferSeconds
}

// HubMinTransferSeconds — минимальное время пересадки внутри узла.
func (t *TravelTimes) HubMinTransferSeconds() int {
	return t.Defaults.HubMinTransferSeconds
}

// Report печатает сводку: сколько рёбер взяло время из конфига, сколько
// уехало на дефолтах и какие ключи конфига не совпали ни с одним ребром.
// Лишний ключ — признак того, что станцию переименовали, удалили или
// сдвинули на другую линию; падать из-за этого нельзя, молчать — тоже.
func (t *TravelTimes) Report(w io.Writer) {
	fmt.Fprintf(w, "travel times: перегоны — %d из конфига, %d на дефолте (%d с); пересадки — %d из конфига, %d на дефолте\n",
		t.rideFromConfig, t.rideDefaults, t.Defaults.RideSeconds, t.transFromConfig, t.transDefaults)
	if t.hubMinFromConfig {
		fmt.Fprintf(w, "travel times: minTransferSeconds хабов — %d с из defaults.hubMinTransferSeconds\n",
			t.Defaults.HubMinTransferSeconds)
	}

	unusedRides := unusedKeys(t.Rides, t.usedRides)
	unusedTransfers := unusedKeys(t.Transfers, t.usedTransfers)
	for _, k := range unusedRides {
		fmt.Fprintf(w, "travel times: ПРЕДУПРЕЖДЕНИЕ — ключу rides[%q] не соответствует ни одно ребро графа (%s)\n",
			k, t.Rides[k].Stations)
	}
	for _, k := range unusedTransfers {
		fmt.Fprintf(w, "travel times: ПРЕДУПРЕЖДЕНИЕ — ключу transfers[%q] не соответствует ни одна пересадка графа (%s)\n",
			k, t.Transfers[k].Stations)
	}
	if len(unusedRides)+len(unusedTransfers) > 0 {
		fmt.Fprintf(w, "travel times: лишних ключей в конфиге — %d (перегоны %d, пересадки %d)\n",
			len(unusedRides)+len(unusedTransfers), len(unusedRides), len(unusedTransfers))
	}

	for _, k := range sortedUnique(t.badSecondsKeys) {
		fmt.Fprintf(w, "travel times: ПРЕДУПРЕЖДЕНИЕ — у ключа %q нет корректного seconds, взят дефолт\n", k)
	}
	for _, m := range sortedUnique(t.kindMismatches) {
		fmt.Fprintf(w, "travel times: ПРЕДУПРЕЖДЕНИЕ — %s (тип пересадки берётся из connections.json)\n", m)
	}
	kinds := make([]string, 0, len(t.unknownKinds))
	for k := range t.unknownKinds {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		fmt.Fprintf(w, "travel times: ПРЕДУПРЕЖДЕНИЕ — для типа пересадки %q нет defaults.transferSeconds, взято %d с (%d рёбер)\n",
			k, baseTransferSeconds, t.unknownKinds[k])
	}
}

func unusedKeys(all map[string]travelTimeEntry, used map[string]struct{}) []string {
	out := make([]string, 0)
	for k := range all {
		if _, ok := used[k]; !ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func sortedUnique(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
