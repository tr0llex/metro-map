package main

import (
	"fmt"
	"math"
	"os"
	"sort"
)

// Финальный проход разведения геометрии.
//
// Задача: убрать три класса дефектов, которые видит пользователь и меряет
// scripts/quality:
//
//   - geometry.stationOnForeignLine — кружок станции лежит на линии чужого
//     маршрута (читается как несуществующая пересадка);
//   - geometry.stationsTooClose — два кружка станций из разных узлов слиплись;
//   - «невидимая» станция out-of-station пересадки (Бульвар Рокоссовского),
//     нарисованная точно поверх своей пары.
//
// Проход обязан идти ПОСЛЕ ApplyRingProjection: он опирается на уже подогнанные
// формы колец и двигает кольцевые станции только вдоль кольца (меняя угол), так
// что rings.projectionError* остаются нулевыми.
//
// Все пороги пересчитаны из визуальных констант рантайма (MetroMap.tsx),
// продублированных в scripts/quality/render.ts:
//
//	stationScale   = 0.95 + (1.1-0.7)/(2.2-0.7)*0.45 = 1.07
//	stationRadius  = 5.2 * 1.07                      = 5.564
//	lineHalfWidth  = 6.4 / 2                         = 3.2
const (
	sepStationRadius   = 5.2 * (0.95 + ((1.1-0.7)/(2.2-0.7))*0.45)
	sepLineHalfWidth   = 6.4 / 2
	sepCorridorOffset  = 3.0
	sepHubStationRadus = sepStationRadius * 0.75

	// Минимум от центра станции до чужой линии (geometry.stationOnForeignLine).
	sepMinLineGap = sepStationRadius + sepLineHalfWidth + 1.5
	// Минимум между центрами станций разных узлов (geometry.stationsTooClose).
	sepMinStationGap = sepStationRadius*2 + 2
	// Запас поверх метрики, чтобы округления и мелкие сдвиги не возвращали дефект.
	sepMargin = 5.2
	// Жёсткий барьер: ниже этого зазора дефект уже засчитывается метрикой,
	// поэтому штраф и сила растут кратно — иначе система «успокаивается»
	// в паре десятых пикселя от порога.
	//
	// sepHardMargin обязан быть строго меньше sepMargin: нарушения ищутся только
	// в радиусе wantLine = sepMinLineGap+sepMargin, и барьер за этим радиусом
	// был бы невидим.
	sepHardMargin = 3.8
	sepHardWeight = 4.0
	// Барьер: цель по честному запасу над порогом метрики.
	//
	// Он обязан быть несопоставим с любым «мягким» выигрышем — иначе перебор
	// охотно жертвует одной зажатой станцией ради того, чтобы подтянуть десяток
	// свободных с 12px до 15px. По той же причине степень здесь четвёртая, а не
	// вторая: сумма квадратов уравнивает «одна станция плохо» и «три станции
	// средне», а нужно ровно обратное — тянуть худшую.
	//
	// Барьер живёт ТОЛЬКО в стоимости (фазы перебора). В силе релаксации ему не
	// место: сила напрямую превращается в сдвиг, и барьерный вес сбивал уже
	// найденное равновесие — проверено, минимальный зазор падал с 11.90px
	// до 10.84px.
	sepBarrierMargin     = 3.0
	sepBarrierCostWeight = 100.0
	// Компактность узла в той же стоимости. Вес за порогом метрики
	// (sepHubСostHardWeight) обязан перебивать барьер: иначе перебор охотно
	// «покупает» зазор до чужой линии ценой разъехавшегося узла — то есть
	// меняет зелёную метрику на красную.
	sepHubCostWeight     = 4.0
	sepHubCostHardWeight = 4000.0
	// Пересадка out-of-station рисуется пунктиром между двумя кружками —
	// им нужен видимый зазор, а не просто «не слиплись».
	sepOutOfStationGap = 18.0
	// ...но и разъезжаться через полсхемы им незачем: для пассажира это одна
	// станция. Верхняя граница мягкая, работает только на «своих» парах.
	sepOutOfStationMax = 40.0
	// Доля силы, которой нарушение отталкивает не станцию, а сам перегон.
	// Маленькая намеренно: большая реакция гасит прямые силы внутри хаба.
	sepReaction = 0.12
	// Радиус окрестности, в которой фаза escape считает стоимость положения.
	sepNearRadius = 160.0
	// Хаб должен читаться как один узел: лимит hubs.notMerged — 3 радиуса
	// станции хаба. sepHubSpreadHard — ровно порог метрики, sepHubSpreadLimit —
	// мягкая цель с запасом.
	sepHubSpreadHard  = sepHubStationRadus * 3
	sepHubSpreadLimit = sepHubStationRadus * 3 * 0.88
	// Сила стягивания хаба должна быть сопоставима с отталкиванием от чужой
	// линии (sepHardWeight), иначе поднятый sepMargin растаскивает узлы.
	sepHubPull     = 6.0
	sepHubPullHard = 40.0
	// Насколько станции разрешено уехать от позиции, нарисованной вручную.
	sepMaxShiftPx = 26.0
	// Насколько кольцевую станцию разрешено сдвинуть вдоль кольца.
	sepMaxRingArcPx = 34.0
	// Число сэмплов кольца: ровно столько же использует модель отрисовки в
	// scripts/quality/render.ts, поэтому расстояния совпадают с метрикой.
	sepRingSamples = 360

	sepIterations = 900
	sepDamping    = 0.35
	// Итерация, в которой ни одна станция не сдвинулась дальше sepMoveEpsilon,
	// считается «пустой». sepStillIterations пустых подряд — признак того, что
	// релаксация сошлась и оставшиеся итерации ничего не изменят.
	//
	// Порог на четыре порядка меньше видимого глазу и метрикой сдвига, поэтому
	// ранний выход не может изменить результат: боевая сборка остаётся
	// побайтово прежней.
	//
	// ЗАМЕР на текущих данных: сдвиг падает экспоненциально до ~450-й итерации,
	// а дальше упирается в полку 5e-4…1.2e-3 px — это не остаточная сходимость,
	// а автоколебание на дискретности кольца (sepRingSamples). То есть на боевой
	// схеме выход не срабатывает ни разу, и все 900 итераций честно
	// откручиваются. Основное ускорение прохода дали не итерации, а точный отсев
	// в горячих циклах (см. polyGrid и отсев по габаритам перегона): 15.2 с → 3.6 с.
	// Порог поднимать нельзя: на полке 5e-4 выход обрубил бы ~450 итераций и
	// сдвинул результат боевой сборки.
	sepMoveEpsilon     = 1e-4
	sepStillIterations = 5
)

type sepNode struct {
	st      *FullGraphStation
	lineID  int
	hubID   string
	ring    *ringTrack
	ringIdx int
	// reqGap[i] — минимальная хорда между станциями i и i+1 своего кольца,
	// которую нельзя ухудшить (см. ringRequiredGaps).
	reqGap []float64
	theta0 float64
	x0, y0 float64
	group  int
	fx, fy float64
}

// ringRequiredGaps считает, насколько близко разрешено подводить соседей по
// кольцу. Метрика rings.spacingUnevenness сравнивает самый короткий перегон
// кольца со средним, поэтому проход не имеет права сокращать перегоны ниже
// уже достигнутого минимума: разрешаем сжимать длинные перегоны максимум до
// текущего минимума кольца, а короткие — не сжимать вовсе.
//
// Перегоны между станциями одного хаба метрика не учитывает (узел намеренно
// рисуется группой кружков), поэтому в минимум они не входят, но и растягивать
// их незачем — им ставится их собственная текущая длина.
func ringRequiredGaps(t *ringTrack, stationByID map[string]*FullGraphStation) []float64 {
	n := len(t.ids)
	gaps := make([]float64, n)
	minGap := math.Inf(1)
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		ax, ay := t.pos(i)
		bx, by := t.pos(j)
		gaps[i] = math.Hypot(bx-ax, by-ay)
		a, b := stationByID[t.ids[i]], stationByID[t.ids[j]]
		sameHub := a != nil && b != nil && a.HubID != "" && a.HubID == b.HubID
		if !sameHub && gaps[i] < minGap {
			minGap = gaps[i]
		}
	}
	if math.IsInf(minGap, 1) {
		minGap = ringMinChordPx
	}
	if minGap < ringMinChordPx {
		minGap = ringMinChordPx
	}
	req := make([]float64, n)
	for i := range gaps {
		req[i] = math.Min(gaps[i], minGap)
	}
	return req
}

// sepRingBounds — допустимый интервал угла станции i с учётом требуемых хорд до
// соседей по кольцу и полного лимита сдвига вдоль дуги.
func sepRingBounds(t *ringTrack, i int, req []float64, maxArc float64) (lo, hi float64) {
	n := len(t.theta)
	cur := t.theta[i]
	prev := t.theta[(i-1+n)%n]
	next := t.theta[(i+1)%n]
	if i == 0 {
		prev -= 2 * math.Pi
	}
	if i == n-1 {
		next += 2 * math.Pi
	}
	scale := t.shape.arcScale(cur)
	chordTheta := func(chord float64) float64 {
		if !isFinite(scale) || scale <= 1e-6 {
			return 0
		}
		s := chord / (2 * scale)
		if s >= 1 {
			return math.Pi
		}
		return 2 * math.Asin(s)
	}
	lo = prev + chordTheta(req[(i-1+n)%n])
	hi = next - chordTheta(req[i])
	if isFinite(scale) && scale > 1e-6 {
		d := maxArc / scale
		if cur-d > lo {
			lo = cur - d
		}
		if cur+d < hi {
			hi = cur + d
		}
	}
	if lo > hi {
		lo, hi = cur, cur
	}
	return
}

type sepSegment struct {
	ax, ay, bx, by float64
	lineID         int
	aID, bID       string
}

// ApplySeparation разводит станции, налезающие на чужие линии и друг на друга.
//
// Проход состоит из двух чередующихся фаз:
//
//	relax  — мягкая релаксация: каждая станция получает суммарную «силу» от
//	         нарушенных ограничений и сдвигается в её сторону;
//	escape — прямой перебор сдвигов для групп, которые релаксация вытащить не
//	         смогла. Он нужен потому, что жёсткая группа (хаб) двигается как
//	         целое: если одну её станцию толкает одна линия, а другую — другая,
//	         средняя сила гасится в ноль, и узел навсегда залипает на чужой
//	         линии (так вело себя ядро Третьяковской в углу Замоскворецкой).

// Выключатель фазы для быстрых итераций: SEP_SKIP=1 полностью пропускает
// разведение (0.2 с вместо 3.6 с на полной сборке). Схема при этом заведомо
// хуже — вернутся geometry.stationOnForeignLine и geometry.stationsTooClose, —
// поэтому проход говорит вслух, что его выключили: молча отдавать другой
// результат нельзя. В боевой сборке переменная не ставится.
func skipSeparation() bool {
	v := os.Getenv("SEP_SKIP")
	return v != "" && v != "0"
}

func ApplySeparation(graph *FullGraphExport, tracks map[int]*ringTrack) {
	if graph == nil {
		return
	}
	if skipSeparation() {
		fmt.Println("separation: ФАЗА ВЫКЛЮЧЕНА через SEP_SKIP — геометрия не разведена, метрики качества будут хуже")
		return
	}

	stationByID := make(map[string]*FullGraphStation, len(graph.Stations))
	for i := range graph.Stations {
		st := &graph.Stations[i]
		stationByID[st.ID] = st
	}

	// Учитываем только станции, реально попавшие на схему (как это делает
	// render.ts: станция без линии или без координат не рисуется).
	used := make(map[string]struct{}, len(graph.Stations))
	for _, ln := range graph.Lines {
		for _, sid := range ln.StationIDs {
			used[sid] = struct{}{}
		}
	}

	reqGapByLine := make(map[int][]float64, len(tracks))
	for lineID, t := range tracks {
		reqGapByLine[lineID] = ringRequiredGaps(t, stationByID)
	}

	nodes := make([]*sepNode, 0, len(graph.Stations))
	byID := make(map[string]*sepNode, len(graph.Stations))
	for i := range graph.Stations {
		st := &graph.Stations[i]
		if _, ok := used[st.ID]; !ok {
			continue
		}
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		n := &sepNode{st: st, lineID: st.LineNumericID, hubID: st.HubID, x0: st.LayoutX, y0: st.LayoutY}
		if t := tracks[st.LineNumericID]; t != nil {
			if idx, ok := t.index[st.ID]; ok {
				n.ring = t
				n.ringIdx = idx
				n.theta0 = t.theta[idx]
				n.reqGap = reqGapByLine[st.LineNumericID]
			}
		}
		nodes = append(nodes, n)
		byID[st.ID] = n
	}

	// --- жёсткие группы: некольцевые станции одного хаба едут вместе ---
	// Кольцевая станция всегда сама по себе: она может двигаться только вдоль
	// своего кольца.
	groupIDs := make([]string, 0)
	groupIndex := make(map[string]int)
	for _, n := range nodes {
		key := "st:" + n.st.ID
		if n.ring == nil && n.hubID != "" {
			key = "hub:" + n.hubID
		}
		if _, ok := groupIndex[key]; !ok {
			groupIndex[key] = len(groupIDs)
			groupIDs = append(groupIDs, key)
		}
		n.group = groupIndex[key]
	}
	groups := make([][]*sepNode, len(groupIDs))
	for _, n := range nodes {
		groups[n.group] = append(groups[n.group], n)
	}

	// --- соседи по хабу: метрика не считает нарушением наезд станции на
	// сегмент, оба конца которого — её соседи по хабу ---
	hubMates := make(map[string]map[string]struct{}, len(nodes))
	hubMembers := make(map[string][]*sepNode)
	for _, n := range nodes {
		if n.hubID == "" {
			continue
		}
		hubMembers[n.hubID] = append(hubMembers[n.hubID], n)
	}
	for _, n := range nodes {
		if n.hubID == "" {
			continue
		}
		set := make(map[string]struct{})
		for _, m := range hubMembers[n.hubID] {
			set[m.st.ID] = struct{}{}
		}
		hubMates[n.st.ID] = set
	}
	hubIDs := make([]string, 0, len(hubMembers))
	for id := range hubMembers {
		hubIDs = append(hubIDs, id)
	}
	sort.Strings(hubIDs)

	excluded := func(n *sepNode, seg *sepSegment) bool {
		if n.lineID == seg.lineID {
			return true
		}
		mates, ok := hubMates[n.st.ID]
		if !ok {
			return false
		}
		if _, m := mates[seg.aID]; m {
			return true
		}
		_, m := mates[seg.bID]
		return m
	}

	// --- полилинии колец: ровно те, по которым метрика считает расстояние ---
	type ringPoly struct {
		lineID int
		pts    []ringPoint
		grid   *polyGrid
	}
	ringPolys := make([]ringPoly, 0, len(tracks))
	ringIDs := make([]int, 0, len(tracks))
	for id := range tracks {
		ringIDs = append(ringIDs, id)
	}
	sort.Ints(ringIDs)
	for _, id := range ringIDs {
		s := tracks[id].shape
		pts := make([]ringPoint, sepRingSamples+1)
		for i := 0; i <= sepRingSamples; i++ {
			th := float64(i) / float64(sepRingSamples) * 2 * math.Pi
			x, y := s.at(th)
			pts[i] = ringPoint{x, y}
		}
		ringPolys = append(ringPolys, ringPoly{lineID: id, pts: pts})
	}

	// --- пары out-of-station пересадок вне общего хаба ---
	type sepPair struct {
		a, b *sepNode
	}
	pairs := make([]sepPair, 0, 8)
	pairsOf := make(map[string][]*sepNode)
	for _, e := range graph.Edges {
		if !e.IsTransfer || e.TransferKind != "out_of_station" {
			continue
		}
		a, b := byID[e.FromStationID], byID[e.ToStationID]
		if a == nil || b == nil {
			continue
		}
		if a.hubID != "" && a.hubID == b.hubID {
			continue
		}
		pairs = append(pairs, sepPair{a: a, b: b})
		pairsOf[a.st.ID] = append(pairsOf[a.st.ID], b)
		pairsOf[b.st.ID] = append(pairsOf[b.st.ID], a)
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].a.st.ID != pairs[j].a.st.ID {
			return pairs[i].a.st.ID < pairs[j].a.st.ID
		}
		return pairs[i].b.st.ID < pairs[j].b.st.ID
	})

	// --- «коридоры»: ребро, принадлежащее нескольким линиям, рисуется со
	// сдвигом ±3px. Повторяем логику corridorEdgeData из MetroMap.tsx ---
	corridorKey := func(a, b string) string {
		if a < b {
			return a + "|" + b
		}
		return b + "|" + a
	}
	corridorUsage := make(map[string][]int)
	for _, ln := range graph.Lines {
		ids := make([]string, 0, len(ln.StationIDs))
		for _, sid := range ln.StationIDs {
			if _, ok := byID[sid]; ok {
				ids = append(ids, sid)
			}
		}
		if len(ids) < 2 {
			continue
		}
		count := len(ids) - 1
		if _, isRing := ringLineIDs[ln.ID]; isRing {
			count = len(ids)
		}
		for i := 0; i < count; i++ {
			k := corridorKey(ids[i], ids[(i+1)%len(ids)])
			arr := corridorUsage[k]
			found := false
			for _, v := range arr {
				if v == ln.ID {
					found = true
					break
				}
			}
			if !found {
				corridorUsage[k] = append(arr, ln.ID)
			}
		}
	}

	// Некольцевые перегоны, которые нужно пересобирать после каждого сдвига.
	type edgeRef struct {
		a, b   *sepNode
		lineID int
	}
	edgeRefs := make([]edgeRef, 0, len(graph.Edges))
	for _, ln := range graph.Lines {
		if _, isRing := ringLineIDs[ln.ID]; isRing && tracks[ln.ID] != nil {
			// У кольца с подогнанной формой рисуется кривая, а не хорды.
			continue
		}
		ids := make([]string, 0, len(ln.StationIDs))
		for _, sid := range ln.StationIDs {
			if _, ok := byID[sid]; ok {
				ids = append(ids, sid)
			}
		}
		if len(ids) < 2 {
			continue
		}
		count := len(ids) - 1
		if _, isRing := ringLineIDs[ln.ID]; isRing {
			count = len(ids)
		}
		for i := 0; i < count; i++ {
			edgeRefs = append(edgeRefs, edgeRef{a: byID[ids[i]], b: byID[ids[(i+1)%len(ids)]], lineID: ln.ID})
		}
	}

	segments := make([]sepSegment, len(edgeRefs))
	// Индексы перегонов, инцидентных станции: их геометрия меняется, когда
	// станция едет, а значит меняются и нарушения у чужих станций рядом.
	incident := make(map[string][]int, len(nodes))
	for i, er := range edgeRefs {
		incident[er.a.st.ID] = append(incident[er.a.st.ID], i)
		incident[er.b.st.ID] = append(incident[er.b.st.ID], i)
	}
	rebuildSegments := func() {
		for i, er := range edgeRefs {
			ax, ay := er.a.st.LayoutX, er.a.st.LayoutY
			bx, by := er.b.st.LayoutX, er.b.st.LayoutY
			var offX, offY float64
			usage := corridorUsage[corridorKey(er.a.st.ID, er.b.st.ID)]
			if len(usage) > 1 {
				idx := -1
				for k, v := range usage {
					if v == er.lineID {
						idx = k
						break
					}
				}
				dx, dy := bx-ax, by-ay
				l := math.Hypot(dx, dy)
				if l > 1e-3 && idx >= 0 {
					oi := float64(idx) - float64(len(usage)-1)/2
					offX = -dy / l * sepCorridorOffset * oi
					offY = dx / l * sepCorridorOffset * oi
				}
			}
			segments[i] = sepSegment{
				ax: ax + offX, ay: ay + offY, bx: bx + offX, by: by + offY,
				lineID: er.lineID, aID: er.a.st.ID, bID: er.b.st.ID,
			}
		}
	}

	// --- жёсткая защита hubs.notMerged ---
	//
	// Силовая релаксация даёт лишь «стремление» удержать хаб компактным: при
	// поднятом sepMargin отталкивание от чужой линии может пересилить стягивание,
	// и узел разъезжается за порог метрики. Поэтому сверх сил стоит прямой
	// запрет: любой сдвиг, который выводит разброс хаба за sepHubSpreadHard и при
	// этом делает хуже, откатывается.
	hubSpread := func(hid string) float64 {
		mem := hubMembers[hid]
		if len(mem) < 2 {
			return 0
		}
		var cx, cy float64
		for _, m := range mem {
			cx += m.st.LayoutX
			cy += m.st.LayoutY
		}
		cx /= float64(len(mem))
		cy /= float64(len(mem))
		worst := 0.0
		for _, m := range mem {
			if d := math.Hypot(m.st.LayoutX-cx, m.st.LayoutY-cy); d > worst {
				worst = d
			}
		}
		return worst
	}
	hubsOf := func(members []*sepNode) []string {
		seen := make(map[string]struct{}, 2)
		out := make([]string, 0, 2)
		for _, m := range members {
			if m.hubID == "" {
				continue
			}
			if _, ok := seen[m.hubID]; ok {
				continue
			}
			seen[m.hubID] = struct{}{}
			out = append(out, m.hubID)
		}
		sort.Strings(out)
		return out
	}
	hubSpreads := func(hids []string) []float64 {
		out := make([]float64, len(hids))
		for i, h := range hids {
			out[i] = hubSpread(h)
		}
		return out
	}
	// hubSpreadsOK — допустимо ли текущее состояние относительно снимка before.
	hubSpreadsOK := func(hids []string, before []float64) bool {
		for i, h := range hids {
			if after := hubSpread(h); after > sepHubSpreadHard && after > before[i]+1e-9 {
				return false
			}
		}
		return true
	}
	// hubGuard выполняет mutate и откатывает его через restore, если хоть один
	// затронутый хаб стал шире порога метрики и шире, чем был до сдвига.
	hubGuard := func(hids []string, mutate, restore func()) bool {
		before := make([]float64, len(hids))
		for i, h := range hids {
			before[i] = hubSpread(h)
		}
		mutate()
		for i, h := range hids {
			if after := hubSpread(h); after > sepHubSpreadHard && after > before[i]+1e-9 {
				restore()
				return false
			}
		}
		return true
	}

	wantLine := sepMinLineGap + sepMargin
	wantStation := sepMinStationGap + sepMargin

	// Форма кольца за время прохода не меняется (ApplyRingProjection уже
	// отработал, релаксация двигает станции ВДОЛЬ кольца), поэтому индекс по
	// её полилинии строится один раз. Без него каждая станция на каждой
	// итерации перебирала все 360 сэмплов каждого кольца — 330 тыс. проверок
	// за итерацию, и это была самая дорогая строчка прохода.
	for i := range ringPolys {
		ringPolys[i].grid = buildPolyGrid(ringPolys[i].pts, wantLine)
	}
	hardLine := sepMinLineGap + sepHardMargin
	barrierLine := sepMinLineGap + sepBarrierMargin

	// linePenalty / lineNeed — три яруса: «мягкая» цель wantLine, жёсткий
	// барьер hardLine и непроходимый barrierLine у самого порога метрики.
	linePenalty := func(d float64) float64 {
		var p float64
		if d < wantLine {
			p = (wantLine - d) * (wantLine - d)
		}
		if d < hardLine {
			p += sepHardWeight * (hardLine - d) * (hardLine - d)
		}
		if d < barrierLine {
			e := barrierLine - d
			p += sepBarrierCostWeight * e * e * e * e
		}
		return p
	}
	lineNeed := func(d float64) float64 {
		need := wantLine - d
		if d < hardLine {
			need += sepHardWeight * (hardLine - d)
		}
		return need
	}

	// --- расстояние до чужой геометрии ---
	distToRings := func(n *sepNode, fn func(lineID int, d, px, py float64)) {
		for _, rp := range ringPolys {
			if n.lineID == rp.lineID {
				continue
			}
			d, px, py := nearestOnPolyline(n.st.LayoutX, n.st.LayoutY, rp.pts, rp.grid, wantLine)
			if d < wantLine {
				fn(rp.lineID, d, px, py)
			}
		}
	}

	// violationOf — суммарный «штраф» станции: квадраты недостающих зазоров.
	stationPenalty := func(n *sepNode) float64 {
		var p float64
		distToRings(n, func(_ int, d, _, _ float64) { p += linePenalty(d) })
		x, y := n.st.LayoutX, n.st.LayoutY
		for si := range segments {
			seg := &segments[si]
			// Тот же точный отсев по габаритам перегона, что и в relax:
			// вне прямоугольника, расширенного на wantLine, штраф заведомо нулевой.
			if x < math.Min(seg.ax, seg.bx)-wantLine || x > math.Max(seg.ax, seg.bx)+wantLine ||
				y < math.Min(seg.ay, seg.by)-wantLine || y > math.Max(seg.ay, seg.by)+wantLine {
				continue
			}
			if excluded(n, seg) {
				continue
			}
			d, _, _ := pointSegNearest(x, y, seg.ax, seg.ay, seg.bx, seg.by)
			if d < wantLine {
				p += linePenalty(d)
			}
		}
		return p
	}

	// --- фаза 1: релаксация ---
	//
	// Ранний выход по стабилизации. Условие `worst < 0.01` не срабатывает
	// никогда: часть ограничений (зазор out-of-station, компактность узла)
	// в равновесии остаётся слегка нарушенной, «сила» не гаснет, и цикл честно
	// откручивал все 900 итераций — 93% времени сборки уходило сюда.
	//
	// Настоящий признак сходимости — не сила, а движение: если за итерацию ни
	// одна станция не сдвинулась заметно, все следующие итерации повторят то же
	// самое. Порог намеренно строгий (sepMoveEpsilon), а срабатывание требует
	// нескольких подряд итераций покоя: одиночная итерация может замереть
	// случайно, на развороте колебания.
	prevX := make([]float64, len(nodes))
	prevY := make([]float64, len(nodes))
	relax := func(iterations int) {
		still := 0
		for iter := 0; iter < iterations; iter++ {
			for i, n := range nodes {
				prevX[i], prevY[i] = n.st.LayoutX, n.st.LayoutY
			}
			rebuildSegments()
			for _, n := range nodes {
				n.fx, n.fy = 0, 0
			}
			worst := 0.0

			// (1) станция на чужой линии — кольца
			for _, n := range nodes {
				distToRings(n, func(_ int, d, px, py float64) {
					ux, uy := unitAway(n.st.LayoutX-px, n.st.LayoutY-py)
					need := lineNeed(d)
					if need > worst {
						worst = need
					}
					n.fx += ux * need
					n.fy += uy * need
				})
			}

			// (1б) станция на чужой линии — обычные перегоны
			//
			// Отсев по габаритному прямоугольнику перегона, расширенному на
			// wantLine. Он точен: если расстояние до отрезка меньше wantLine,
			// точка обязана лежать внутри такого прямоугольника — то есть
			// отбрасываются ровно те пары, которые всё равно дали бы `continue`
			// ниже. Результат байт-в-байт тот же, но 306 станций × 368 перегонов
			// перестают гонять через pointSegNearest на каждой из сотен итераций.
			for si := range segments {
				seg := &segments[si]
				loX, hiX := math.Min(seg.ax, seg.bx)-wantLine, math.Max(seg.ax, seg.bx)+wantLine
				loY, hiY := math.Min(seg.ay, seg.by)-wantLine, math.Max(seg.ay, seg.by)+wantLine
				for _, n := range nodes {
					x, y := n.st.LayoutX, n.st.LayoutY
					if x < loX || x > hiX || y < loY || y > hiY {
						continue
					}
					if excluded(n, seg) {
						continue
					}
					d, px, py := pointSegNearest(x, y, seg.ax, seg.ay, seg.bx, seg.by)
					if d >= wantLine {
						continue
					}
					ux, uy := unitAway(n.st.LayoutX-px, n.st.LayoutY-py)
					need := lineNeed(d)
					if need > worst {
						worst = need
					}
					n.fx += ux * need
					n.fy += uy * need
					// Слабая реакция на концах перегона: увести саму линию.
					// Слабая намеренно — сильная гасит прямые силы внутри хаба.
					if a := byID[seg.aID]; a != nil {
						a.fx -= ux * need * sepReaction
						a.fy -= uy * need * sepReaction
					}
					if b := byID[seg.bID]; b != nil {
						b.fx -= ux * need * sepReaction
						b.fy -= uy * need * sepReaction
					}
				}
			}

			// (2) слипшиеся станции разных узлов
			for i := 0; i < len(nodes); i++ {
				a := nodes[i]
				for j := i + 1; j < len(nodes); j++ {
					b := nodes[j]
					if a.hubID != "" && a.hubID == b.hubID {
						continue
					}
					dx := b.st.LayoutX - a.st.LayoutX
					dy := b.st.LayoutY - a.st.LayoutY
					d := math.Hypot(dx, dy)
					if d >= wantStation {
						continue
					}
					ux, uy := unitAway(dx, dy)
					need := wantStation - d
					if need > worst {
						worst = need
					}
					a.fx -= ux * need / 2
					a.fy -= uy * need / 2
					b.fx += ux * need / 2
					b.fy += uy * need / 2
				}
			}

			// (3) пересадка out-of-station: видимый зазор, но и не через
			// полсхемы — это одна и та же станция для пассажира.
			for _, p := range pairs {
				dx := p.b.st.LayoutX - p.a.st.LayoutX
				dy := p.b.st.LayoutY - p.a.st.LayoutY
				d := math.Hypot(dx, dy)
				var need float64
				switch {
				case d < sepOutOfStationGap:
					need = sepOutOfStationGap - d
				case d > sepOutOfStationMax:
					need = sepOutOfStationMax - d
				default:
					continue
				}
				ux, uy := unitAway(dx, dy)
				p.a.fx -= ux * need / 2
				p.a.fy -= uy * need / 2
				p.b.fx += ux * need / 2
				p.b.fy += uy * need / 2
			}

			// (4) хаб не должен разъехаться
			for _, hid := range hubIDs {
				members := hubMembers[hid]
				if len(members) < 2 {
					continue
				}
				var cx, cy float64
				for _, m := range members {
					cx += m.st.LayoutX
					cy += m.st.LayoutY
				}
				cx /= float64(len(members))
				cy /= float64(len(members))
				for _, m := range members {
					dx := cx - m.st.LayoutX
					dy := cy - m.st.LayoutY
					d := math.Hypot(dx, dy)
					if d <= sepHubSpreadLimit {
						continue
					}
					ux, uy := unitAway(dx, dy)
					pull := (d - sepHubSpreadLimit) * sepHubPull
					if d > sepHubSpreadHard {
						pull += (d - sepHubSpreadHard) * sepHubPullHard
					}
					m.fx += ux * pull
					m.fy += uy * pull
				}
			}

			// (5) пружина к нарисованной вручную позиции
			for _, n := range nodes {
				n.fx += (n.x0 - n.st.LayoutX) * 0.03
				n.fy += (n.y0 - n.st.LayoutY) * 0.03
			}

			for _, n := range nodes {
				if n.ring == nil {
					continue
				}
				next, ok := ringNextTheta(n)
				if !ok {
					continue
				}
				prevTheta := n.ring.theta[n.ringIdx]
				prevX, prevY := n.st.LayoutX, n.st.LayoutY
				hubGuard(hubsOf([]*sepNode{n}),
					func() { setRingThetaRaw(n, next) },
					func() {
						n.ring.theta[n.ringIdx] = prevTheta
						n.st.LayoutX, n.st.LayoutY = prevX, prevY
					})
			}
			for gi := range groups {
				members := groups[gi]
				if len(members) == 0 || members[0].ring != nil {
					continue
				}
				var fx, fy float64
				for _, m := range members {
					fx += m.fx
					fy += m.fy
				}
				fx = fx / float64(len(members)) * sepDamping
				fy = fy / float64(len(members)) * sepDamping
				if !isFinite(fx) || !isFinite(fy) {
					continue
				}
				// Лимит сдвига от ручной позиции — но движение «домой» разрешено
				// всегда: иначе группа, уже стоящая на границе, залипает и не
				// может вернуться под ограничение.
				var curMax, newMax float64
				for _, m := range members {
					curMax = math.Max(curMax, math.Hypot(m.st.LayoutX-m.x0, m.st.LayoutY-m.y0))
					newMax = math.Max(newMax, math.Hypot(m.st.LayoutX+fx-m.x0, m.st.LayoutY+fy-m.y0))
				}
				if newMax > sepMaxShiftPx && newMax > curMax {
					continue
				}
				hubGuard(hubsOf(members),
					func() {
						for _, m := range members {
							m.st.LayoutX += fx
							m.st.LayoutY += fy
						}
					},
					func() {
						for _, m := range members {
							m.st.LayoutX -= fx
							m.st.LayoutY -= fy
						}
					})
			}

			if worst < 0.01 {
				break
			}

			maxMove := 0.0
			for i, n := range nodes {
				if d := math.Hypot(n.st.LayoutX-prevX[i], n.st.LayoutY-prevY[i]); d > maxMove {
					maxMove = d
				}
			}
			if maxMove < sepMoveEpsilon {
				still++
				if still >= sepStillIterations {
					if os.Getenv("SEP_DEBUG") != "" {
						fmt.Printf("SEP relax сошлась на итерации %d из %d (maxMove=%.2e)\n", iter+1, iterations, maxMove)
					}
					break
				}
			} else {
				still = 0
			}
		}
		rebuildSegments()
	}

	// --- фаза 2: перебор сдвигов для залипших групп ---

	// Стоимость положения группы: собственные нарушения её станций плюс
	// нарушения соседей об изменившиеся перегоны этой группы.
	groupCost := func(members []*sepNode, near []*sepNode) float64 {
		var cost float64
		for _, m := range members {
			cost += stationPenalty(m)
			// станции чужих узлов слишком близко
			for _, q := range near {
				if m.hubID != "" && m.hubID == q.hubID {
					continue
				}
				d := math.Hypot(q.st.LayoutX-m.st.LayoutX, q.st.LayoutY-m.st.LayoutY)
				if d < wantStation {
					cost += (wantStation - d) * (wantStation - d)
				}
			}
			// пересадка out-of-station
			for _, q := range pairsOf[m.st.ID] {
				d := math.Hypot(q.st.LayoutX-m.st.LayoutX, q.st.LayoutY-m.st.LayoutY)
				if d < sepOutOfStationGap {
					cost += (sepOutOfStationGap - d) * (sepOutOfStationGap - d)
				} else if d > sepOutOfStationMax {
					cost += (d - sepOutOfStationMax) * (d - sepOutOfStationMax) * 0.25
				}
			}
			// сдвиг от нарисованной вручную позиции
			dd := math.Hypot(m.st.LayoutX-m.x0, m.st.LayoutY-m.y0)
			cost += dd * dd * 0.02
			// компактность хаба
			if m.hubID != "" {
				mem := hubMembers[m.hubID]
				var cx, cy float64
				for _, h := range mem {
					cx += h.st.LayoutX
					cy += h.st.LayoutY
				}
				cx /= float64(len(mem))
				cy /= float64(len(mem))
				d := math.Hypot(m.st.LayoutX-cx, m.st.LayoutY-cy)
				if d > sepHubSpreadLimit {
					cost += (d - sepHubSpreadLimit) * (d - sepHubSpreadLimit) * sepHubCostWeight
				}
				if d > sepHubSpreadHard {
					cost += (d - sepHubSpreadHard) * (d - sepHubSpreadHard) * sepHubCostHardWeight
				}
			}
			// соседи, которым мешают перегоны этой станции
			for _, si := range incident[m.st.ID] {
				seg := &segments[si]
				for _, q := range near {
					if excluded(q, seg) {
						continue
					}
					d, _, _ := pointSegNearest(q.st.LayoutX, q.st.LayoutY, seg.ax, seg.ay, seg.bx, seg.by)
					if d < wantLine {
						cost += linePenalty(d)
					}
				}
			}
		}
		return cost
	}

	nearOf := func(members []*sepNode) []*sepNode {
		var cx, cy float64
		for _, m := range members {
			cx += m.st.LayoutX
			cy += m.st.LayoutY
		}
		cx /= float64(len(members))
		cy /= float64(len(members))
		out := make([]*sepNode, 0, 32)
		for _, q := range nodes {
			same := false
			for _, m := range members {
				if m == q {
					same = true
					break
				}
			}
			if same {
				continue
			}
			if math.Hypot(q.st.LayoutX-cx, q.st.LayoutY-cy) <= sepNearRadius {
				out = append(out, q)
			}
		}
		return out
	}

	moveGroup := func(members []*sepNode, dx, dy float64) {
		for _, m := range members {
			m.st.LayoutX += dx
			m.st.LayoutY += dy
		}
		rebuildSegments()
	}

	setRingTheta := func(n *sepNode, th float64) {
		n.ring.theta[n.ringIdx] = th
		x, y := n.ring.shape.at(th)
		n.st.LayoutX = x
		n.st.LayoutY = y
		rebuildSegments()
	}

	escape := func() {
		rebuildSegments()
		for gi := range groups {
			members := groups[gi]
			if len(members) == 0 {
				continue
			}
			stuck := false
			for _, m := range members {
				if stationPenalty(m) > 1e-6 {
					stuck = true
					break
				}
			}
			if !stuck {
				continue
			}
			near := nearOf(members)

			if members[0].ring != nil {
				// Кольцевая станция: перебираем угол в допустимом коридоре.
				n := members[0]
				lo, hi := sepRingBounds(n.ring, n.ringIdx, n.reqGap, sepMaxRingArcPx)
				if hi-lo < 1e-9 {
					continue
				}
				cur := n.ring.theta[n.ringIdx]
				hids := hubsOf(members)
				before := hubSpreads(hids)
				best := cur
				bestCost := groupCost(members, near)
				const samples = 96
				for s := 0; s <= samples; s++ {
					v := lo + (hi-lo)*float64(s)/float64(samples)
					setRingTheta(n, v)
					if !hubSpreadsOK(hids, before) {
						continue
					}
					if c := groupCost(members, near); c < bestCost-1e-9 {
						bestCost = c
						best = v
					}
				}
				setRingTheta(n, best)
				continue
			}

			bestCost := groupCost(members, near)
			hids := hubsOf(members)
			before := hubSpreads(hids)
			var bestDX, bestDY float64
			const dirs = 24
			radii := []float64{1, 2, 3, 4, 6, 8, 11, 14, 18, 22, 26}
			for di := 0; di < dirs; di++ {
				a := 2 * math.Pi * float64(di) / float64(dirs)
				ux, uy := math.Cos(a), math.Sin(a)
				for _, r := range radii {
					dx, dy := ux*r, uy*r
					tooFar := false
					for _, m := range members {
						if math.Hypot(m.st.LayoutX+dx-m.x0, m.st.LayoutY+dy-m.y0) > sepMaxShiftPx {
							tooFar = true
							break
						}
					}
					if tooFar {
						continue
					}
					moveGroup(members, dx, dy)
					ok := hubSpreadsOK(hids, before)
					c := groupCost(members, near)
					moveGroup(members, -dx, -dy)
					if ok && c < bestCost-1e-9 {
						bestCost = c
						bestDX, bestDY = dx, dy
					}
				}
			}
			if bestDX != 0 || bestDY != 0 {
				moveGroup(members, bestDX, bestDY)
			}
		}
	}

	// --- фаза 3: согласованный сдвиг всего пересадочного узла ---
	//
	// relax и escape двигают ровно одну жёсткую группу за раз и откатывают любой
	// шаг, выводящий разброс хаба за порог метрики. Для узла, уже стоящего
	// вплотную к этому порогу, это тупик: выход из ямы требует одновременного
	// смещения всех его станций, а каждый отдельный шаг к нему запрещён.
	//
	// Так залипала Нижегородская: её станция БКЛ стоит на пересечении кривых БКЛ
	// и МЦК, в 8.9px от чужой линии, хотя совместный сдвиг тройки станций даёт
	// 14.6px при том же разбросе узла (проверено прямым перебором).
	//
	// Здесь узел перебирается целиком: покоординатный спуск по всем его подвижным
	// единицам (каждая кольцевая станция отдельно вдоль своего кольца, все
	// некольцевые — одной группой) БЕЗ пошагового запрета, а разброс проверяется
	// один раз в конце. Стало хуже по стоимости или шире порога — откат целиком.
	hubEscape := func() {
		rebuildSegments()
		for _, hid := range hubIDs {
			members := hubMembers[hid]
			if len(members) < 2 {
				continue
			}
			stuck := false
			for _, m := range members {
				if stationPenalty(m) > 1e-6 {
					stuck = true
					break
				}
			}
			if !stuck {
				continue
			}

			// Подвижные единицы узла.
			units := make([][]*sepNode, 0, len(members))
			plain := make([]*sepNode, 0, len(members))
			for _, m := range members {
				if m.ring != nil {
					units = append(units, []*sepNode{m})
				} else {
					plain = append(plain, m)
				}
			}
			if len(plain) > 0 {
				units = append(units, plain)
			}
			if len(units) < 2 {
				continue
			}

			near := nearOf(members)
			spreadBefore := hubSpread(hid)
			// Разброс узла — не слагаемое стоимости, а стена: перебор просто не
			// видит положений, в которых hubs.notMerged/spreadP95 поехали бы.
			// Штрафом это не решается — превышение на сотые доли пикселя стоит
			// копейки, и весь найденный выигрыш откатывался целиком.
			cost := func() float64 {
				if s := hubSpread(hid); s > sepHubSpreadHard && s > spreadBefore+1e-9 {
					return math.Inf(1)
				}
				return groupCost(members, near)
			}

			type snap struct {
				x, y, theta float64
			}
			saved := make([]snap, len(members))
			for i, m := range members {
				saved[i] = snap{x: m.st.LayoutX, y: m.st.LayoutY}
				if m.ring != nil {
					saved[i].theta = m.ring.theta[m.ringIdx]
				}
			}
			restore := func() {
				for i, m := range members {
					m.st.LayoutX, m.st.LayoutY = saved[i].x, saved[i].y
					if m.ring != nil {
						m.ring.theta[m.ringIdx] = saved[i].theta
					}
				}
				rebuildSegments()
			}
			costBefore := cost()

			// Совместный перебор пар подвижных единиц узла.
			//
			// Покоординатный спуск на связанной задаче застревает: у Нижегородской
			// углы станций МЦК и БКЛ надо менять одновременно (порознь каждый шаг
			// либо ухудшает зазор, либо разъезжает узел), и спуск честно
			// останавливается в 11.6px при физически достижимых 14.6px.
			//
			// Позиции единицы перечисляет placements: для кольцевой станции это
			// углы в допустимом коридоре, для группы некольцевых — сдвиги по
			// направлениям. Единый интерфейс позволяет перебирать совместно любую
			// пару, включая «кольцевая станция × остальные станции узла».
			type placement struct {
				theta  float64
				dx, dy float64
			}
			placements := func(u []*sepNode) []placement {
				if u[0].ring != nil {
					n := u[0]
					lo, hi := sepRingBounds(n.ring, n.ringIdx, n.reqGap, sepMaxRingArcPx)
					if hi-lo < 1e-9 {
						return nil
					}
					const samples = 28
					out := make([]placement, 0, samples+1)
					for s := 0; s <= samples; s++ {
						out = append(out, placement{theta: lo + (hi-lo)*float64(s)/float64(samples)})
					}
					return out
				}
				out := make([]placement, 0, 1+16*8)
				out = append(out, placement{})
				const dirs = 16
				for di := 0; di < dirs; di++ {
					a := 2 * math.Pi * float64(di) / float64(dirs)
					ux, uy := math.Cos(a), math.Sin(a)
					for _, r := range []float64{1, 2, 4, 6, 9, 12, 16, 20} {
						dx, dy := ux*r, uy*r
						tooFar := false
						for _, m := range u {
							if math.Hypot(m.st.LayoutX+dx-m.x0, m.st.LayoutY+dy-m.y0) > sepMaxShiftPx {
								tooFar = true
								break
							}
						}
						if !tooFar {
							out = append(out, placement{dx: dx, dy: dy})
						}
					}
				}
				return out
			}
			// apply возвращает функцию отката.
			apply := func(u []*sepNode, p placement) func() {
				if u[0].ring != nil {
					n := u[0]
					prev := n.ring.theta[n.ringIdx]
					setRingTheta(n, p.theta)
					return func() { setRingTheta(n, prev) }
				}
				if p.dx == 0 && p.dy == 0 {
					return func() {}
				}
				moveGroup(u, p.dx, p.dy)
				return func() { moveGroup(u, -p.dx, -p.dy) }
			}
			// Совместно перебираются только пары кольцевых станций. Добавление в
			// перебор некольцевой группы проверено и отвергнуто: свободы больше,
			// суммарная стоимость ниже, но квадратичный барьер охотно разменивает
			// худшую станцию на несколько средних — минимальный зазор падал с
			// 12.06px до 11.80px, а сборка замедлялась с 17с до 57с.
			jointPairSweep := func() {
				for i := 0; i < len(units); i++ {
					if units[i][0].ring == nil {
						continue
					}
					for j := i + 1; j < len(units); j++ {
						if units[j][0].ring == nil {
							continue
						}
						pi, pj := placements(units[i]), placements(units[j])
						if len(pi) == 0 || len(pj) == 0 {
							continue
						}
						bestCost := cost()
						var bestI, bestJ placement
						found := false
						for _, a := range pi {
							undoA := apply(units[i], a)
							for _, b := range pj {
								undoB := apply(units[j], b)
								if c := cost(); c < bestCost-1e-9 {
									bestCost, bestI, bestJ, found = c, a, b, true
								}
								undoB()
							}
							undoA()
						}
						if found {
							apply(units[i], bestI)
							apply(units[j], bestJ)
						}
					}
				}
			}

			for round := 0; round < 3; round++ {
				// Чередуется с перебором остальных станций узла: совместный оптимум
				// углов зависит от того, где стоят некольцевые станции того же узла,
				// и наоборот.
				jointPairSweep()
				for _, u := range units {
					if u[0].ring != nil {
						n := u[0]
						lo, hi := sepRingBounds(n.ring, n.ringIdx, n.reqGap, sepMaxRingArcPx)
						if hi-lo < 1e-9 {
							continue
						}
						cur := n.ring.theta[n.ringIdx]
						best, bestCost := cur, cost()
						const samples = 64
						for s := 0; s <= samples; s++ {
							v := lo + (hi-lo)*float64(s)/float64(samples)
							setRingTheta(n, v)
							if c := cost(); c < bestCost-1e-9 {
								bestCost, best = c, v
							}
						}
						setRingTheta(n, best)
						continue
					}
					bestCost := cost()
					var bestDX, bestDY float64
					const dirs = 16
					for di := 0; di < dirs; di++ {
						a := 2 * math.Pi * float64(di) / float64(dirs)
						ux, uy := math.Cos(a), math.Sin(a)
						for _, r := range []float64{1, 2, 4, 6, 9, 12, 16, 20} {
							dx, dy := ux*r, uy*r
							tooFar := false
							for _, m := range u {
								if math.Hypot(m.st.LayoutX+dx-m.x0, m.st.LayoutY+dy-m.y0) > sepMaxShiftPx {
									tooFar = true
									break
								}
							}
							if tooFar {
								continue
							}
							moveGroup(u, dx, dy)
							c := cost()
							moveGroup(u, -dx, -dy)
							if c < bestCost-1e-9 {
								bestCost, bestDX, bestDY = c, dx, dy
							}
						}
					}
					if bestDX != 0 || bestDY != 0 {
						moveGroup(u, bestDX, bestDY)
					}
				}
			}

			after := hubSpread(hid)
			bad := cost() >= costBefore-1e-9 || (after > sepHubSpreadHard && after > spreadBefore+1e-9)
			if os.Getenv("SEP_DEBUG") != "" {
				fmt.Printf("HUBESC %s cost %.1f->%.1f spread %.2f->%.2f rollback=%v\n", hid, costBefore, cost(), spreadBefore, after, bad)
			}
			if bad {
				restore()
			}
		}
		rebuildSegments()
	}

	for cycle := 0; cycle < 4; cycle++ {
		relax(sepIterations)
		escape()
		hubEscape()
	}
	relax(sepIterations)
	// Финальная релаксация — компромисс всех сил сразу, и она умеет слегка
	// сдать назад по узлам, вытащенным из ямы. hubEscape после неё либо
	// улучшает результат, либо не делает ничего: он откатывает всё, что
	// ухудшило стоимость.
	hubEscape()

	if os.Getenv("SEP_DEBUG") != "" {
		rebuildSegments()
		for _, n := range nodes {
			distToRings(n, func(lineID int, d, _, _ float64) {
				fmt.Printf("SEP ring  %-24s line %3d vs ring %3d: %.2f (need %.2f)\n", n.st.Title, n.lineID, lineID, d, wantLine)
			})
			for si := range segments {
				seg := &segments[si]
				if excluded(n, seg) {
					continue
				}
				d, _, _ := pointSegNearest(n.st.LayoutX, n.st.LayoutY, seg.ax, seg.ay, seg.bx, seg.by)
				if d < wantLine {
					fmt.Printf("SEP seg   %-24s line %3d vs line %3d (%s-%s): %.2f (need %.2f)\n",
						n.st.Title, n.lineID, seg.lineID, byID[seg.aID].st.Title, byID[seg.bID].st.Title, d, wantLine)
				}
			}
		}
	}
}

// setRingThetaRaw ставит станцию кольца в заданный угол на её форме.
// Станция кольца обязана остаться ровно на форме — меняется только угол,
// поэтому rings.projectionError* остаются нулевыми.
func setRingThetaRaw(n *sepNode, th float64) {
	n.ring.theta[n.ringIdx] = th
	x, y := n.ring.shape.at(th)
	if isFinite(x) && isFinite(y) {
		n.st.LayoutX = x
		n.st.LayoutY = y
	}
}

// ringNextTheta переводит накопленную силу в сдвиг вдоль кольца и возвращает
// новый угол. Применение вынесено наружу, чтобы вызывающий мог откатить сдвиг,
// разъезжающий пересадочный узел (см. hubGuard).
func ringNextTheta(n *sepNode) (float64, bool) {
	t := n.ring
	th := t.theta[n.ringIdx]
	// Касательная к форме в текущей точке.
	var tx, ty float64
	if t.shape.kind == "circle" {
		tx, ty = -t.shape.r*math.Sin(th), t.shape.r*math.Cos(th)
	} else {
		tx, ty = -t.shape.rx*math.Sin(th), t.shape.ry*math.Cos(th)
	}
	scale := math.Hypot(tx, ty)
	if !isFinite(scale) || scale <= 1e-6 {
		return 0, false
	}
	tx /= scale
	ty /= scale
	arc := (n.fx*tx + n.fy*ty) * sepDamping
	if !isFinite(arc) || arc == 0 {
		return 0, false
	}
	next := th + arc/scale

	lo, hi := sepRingBounds(t, n.ringIdx, n.reqGap, sepMaxRingArcPx)
	if next < lo {
		next = lo
	}
	if next > hi {
		next = hi
	}
	// Полный сдвиг от исходного угла тоже ограничен.
	if math.Abs(next-n.theta0)*scale > sepMaxRingArcPx {
		if next > n.theta0 {
			next = n.theta0 + sepMaxRingArcPx/scale
		} else {
			next = n.theta0 - sepMaxRingArcPx/scale
		}
	}
	if !isFinite(next) || next == th {
		return 0, false
	}
	return next, true
}

func unitAway(dx, dy float64) (float64, float64) {
	d := math.Hypot(dx, dy)
	if d < 1e-6 {
		return 1, 0
	}
	return dx / d, dy / d
}

// pointSegNearest — расстояние от точки до отрезка и ближайшая точка на нём.
func pointSegNearest(px, py, ax, ay, bx, by float64) (float64, float64, float64) {
	dx := bx - ax
	dy := by - ay
	l2 := dx*dx + dy*dy
	if l2 <= 1e-12 {
		return math.Hypot(px-ax, py-ay), ax, ay
	}
	t := ((px-ax)*dx + (py-ay)*dy) / l2
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	cx := ax + t*dx
	cy := ay + t*dy
	return math.Hypot(px-cx, py-cy), cx, cy
}

// polyGrid — равномерная сетка над отрезками полилинии: по ячейке сразу видно,
// какие отрезки могут оказаться ближе limit к точке внутри неё.
//
// Индекс строится один раз на неподвижную полилинию (форму кольца) и заменяет
// полный перебор её сэмплов. Он ТОЧЕН: отрезок кладётся во все ячейки своего
// габаритного прямоугольника, расширенного на limit, поэтому в списке ячейки
// заведомо есть все отрезки, проходящие проверку по bbox. Лишние кандидаты
// результат не портят — у них расстояние заведомо больше limit, а вызывающий
// код смотрит только на d < limit.
type polyGrid struct {
	cell       float64
	minX, minY float64
	nx, ny     int
	cells      [][]int32
}

// polyGridCell — сторона ячейки. Заметно больше типичного limit (~15 px), чтобы
// один отрезок не размазывался по десяткам ячеек, и заметно меньше кольца.
const polyGridCell = 48.0

func buildPolyGrid(pts []ringPoint, limit float64) *polyGrid {
	if len(pts) < 2 {
		return nil
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, p := range pts {
		minX, maxX = math.Min(minX, p.x), math.Max(maxX, p.x)
		minY, maxY = math.Min(minY, p.y), math.Max(maxY, p.y)
	}
	if !isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY) {
		return nil
	}
	g := &polyGrid{cell: polyGridCell, minX: minX - limit, minY: minY - limit}
	g.nx = int((maxX+limit-g.minX)/g.cell) + 1
	g.ny = int((maxY+limit-g.minY)/g.cell) + 1
	if g.nx <= 0 || g.ny <= 0 {
		return nil
	}
	g.cells = make([][]int32, g.nx*g.ny)

	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		x0 := int((math.Min(a.x, b.x) - limit - g.minX) / g.cell)
		x1 := int((math.Max(a.x, b.x) + limit - g.minX) / g.cell)
		y0 := int((math.Min(a.y, b.y) - limit - g.minY) / g.cell)
		y1 := int((math.Max(a.y, b.y) + limit - g.minY) / g.cell)
		x0, y0 = max(x0, 0), max(y0, 0)
		x1, y1 = min(x1, g.nx-1), min(y1, g.ny-1)
		for gy := y0; gy <= y1; gy++ {
			for gx := x0; gx <= x1; gx++ {
				idx := gy*g.nx + gx
				g.cells[idx] = append(g.cells[idx], int32(i))
			}
		}
	}
	return g
}

// at возвращает список отрезков-кандидатов для точки; nil — точка вне сетки,
// то есть кандидатов нет вовсе.
func (g *polyGrid) at(px, py float64) []int32 {
	gx := int((px - g.minX) / g.cell)
	gy := int((py - g.minY) / g.cell)
	if gx < 0 || gy < 0 || gx >= g.nx || gy >= g.ny {
		return nil
	}
	return g.cells[gy*g.nx+gx]
}

// nearestOnPolyline ищет ближайшую точку полилинии. grid может быть nil —
// тогда перебираются все отрезки.
func nearestOnPolyline(px, py float64, pts []ringPoint, grid *polyGrid, limit float64) (float64, float64, float64) {
	best := math.Inf(1)
	var bx, by float64
	check := func(i int) {
		a, b := pts[i], pts[i+1]
		// Грубый отсев по bbox отрезка.
		if px < math.Min(a.x, b.x)-limit || px > math.Max(a.x, b.x)+limit ||
			py < math.Min(a.y, b.y)-limit || py > math.Max(a.y, b.y)+limit {
			return
		}
		d, cx, cy := pointSegNearest(px, py, a.x, a.y, b.x, b.y)
		if d < best {
			best, bx, by = d, cx, cy
		}
	}
	if grid != nil {
		for _, i := range grid.at(px, py) {
			check(int(i))
		}
		return best, bx, by
	}
	for i := 0; i+1 < len(pts); i++ {
		check(i)
	}
	return best, bx, by
}
