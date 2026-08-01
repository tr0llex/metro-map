package main

import (
	"math"
	"sort"
	"strconv"
)

// Финальный проход раскладки кольцевых линий.
//
// Задача: сделать так, чтобы координаты станций в fullGraph.json уже лежали
// ровно на аналитической форме кольца, а сама форма была записана в поле
// ringShapes. Раньше эту проекцию делал рантайм (MetroMap.tsx,
// getRingShapeForLine + projectPointToRingShape), из-за чего картинка на экране
// расходилась с данными на десятки пикселей.
//
// Проход обязан выполняться ПОСЛЕДНИМ, после ApplyLayoutOverrides: ручные
// оверрайды из редактора полностью перезаписывают layoutX/layoutY.

const (
	// Минимальная хорда между соседними станциями на кольце.
	// Совпадает с минимумом, который есть в исходных данных, — проход не
	// пытается «улучшить» ручную раскладку, только не даёт ей стать хуже.
	ringMinChordPx = 16.0
	// Максимальный сдвиг кольцевой станции вдоль кольца при разрешении
	// конфликта хаба (в пикселях длины дуги).
	ringHubMaxArcShiftPx = 60.0
)

type ringShape struct {
	kind   string // "circle" | "ellipse"
	cx, cy float64
	r      float64 // circle
	rx, ry float64 // ellipse
}

func (s ringShape) theta(x, y float64) float64 {
	if s.kind == "circle" {
		return math.Atan2(y-s.cy, x-s.cx)
	}
	return math.Atan2((y-s.cy)/s.ry, (x-s.cx)/s.rx)
}

func (s ringShape) at(theta float64) (float64, float64) {
	if s.kind == "circle" {
		return s.cx + s.r*math.Cos(theta), s.cy + s.r*math.Sin(theta)
	}
	return s.cx + s.rx*math.Cos(theta), s.cy + s.ry*math.Sin(theta)
}

func (s ringShape) project(x, y float64) (float64, float64) {
	return s.at(s.theta(x, y))
}

// arcScale — |dP/dtheta|, локальный коэффициент перевода угла в длину дуги.
func (s ringShape) arcScale(theta float64) float64 {
	if s.kind == "circle" {
		return s.r
	}
	return math.Hypot(s.rx*math.Sin(theta), s.ry*math.Cos(theta))
}

func (s ringShape) valid() bool {
	if !isFinite(s.cx) || !isFinite(s.cy) {
		return false
	}
	if s.kind == "circle" {
		return isFinite(s.r) && s.r > 0
	}
	return isFinite(s.rx) && isFinite(s.ry) && s.rx > 0 && s.ry > 0
}

type ringPoint struct{ x, y float64 }

// ---------------------------------------------------------------------------
// Подгонка формы
// ---------------------------------------------------------------------------

// ringResidual — среднеквадратичное отклонение точек от формы, измеренное ровно
// тем же способом, каким потом делается проекция.
func ringResidual(s ringShape, pts []ringPoint) float64 {
	if len(pts) == 0 || !s.valid() {
		return math.Inf(1)
	}
	var sum float64
	for _, p := range pts {
		px, py := s.project(p.x, p.y)
		d := math.Hypot(px-p.x, py-p.y)
		sum += d * d
	}
	return math.Sqrt(sum / float64(len(pts)))
}

func ringMeanMaxDev(s ringShape, pts []ringPoint) (mean, max float64) {
	for _, p := range pts {
		px, py := s.project(p.x, p.y)
		d := math.Hypot(px-p.x, py-p.y)
		mean += d
		if d > max {
			max = d
		}
	}
	if len(pts) > 0 {
		mean /= float64(len(pts))
	}
	return
}

// solveLinear — решение плотной СЛАУ методом Гаусса с частичным выбором.
func solveLinear(a [][]float64, b []float64) ([]float64, bool) {
	n := len(b)
	m := make([][]float64, n)
	for i := range m {
		m[i] = make([]float64, n+1)
		copy(m[i], a[i])
		m[i][n] = b[i]
	}
	for col := 0; col < n; col++ {
		piv := col
		for r := col + 1; r < n; r++ {
			if math.Abs(m[r][col]) > math.Abs(m[piv][col]) {
				piv = r
			}
		}
		if math.Abs(m[piv][col]) < 1e-12 {
			return nil, false
		}
		m[col], m[piv] = m[piv], m[col]
		for r := 0; r < n; r++ {
			if r == col {
				continue
			}
			f := m[r][col] / m[col][col]
			if f == 0 {
				continue
			}
			for c := col; c <= n; c++ {
				m[r][c] -= f * m[col][c]
			}
		}
	}
	out := make([]float64, n)
	for i := 0; i < n; i++ {
		out[i] = m[i][n] / m[i][i]
		if !isFinite(out[i]) {
			return nil, false
		}
	}
	return out, true
}

// normalEquations — МНК для модели y = sum(coef_k * basis_k(point)).
func normalEquations(rows [][]float64, rhs []float64) ([]float64, bool) {
	if len(rows) == 0 {
		return nil, false
	}
	k := len(rows[0])
	if len(rows) < k {
		return nil, false
	}
	ata := make([][]float64, k)
	for i := range ata {
		ata[i] = make([]float64, k)
	}
	atb := make([]float64, k)
	for r, row := range rows {
		for i := 0; i < k; i++ {
			for j := 0; j < k; j++ {
				ata[i][j] += row[i] * row[j]
			}
			atb[i] += row[i] * rhs[r]
		}
	}
	return solveLinear(ata, atb)
}

// fitCircleAlgebraic — алгебраический фит Кása:
// x^2 + y^2 = 2*cx*x + 2*cy*y + (r^2 - cx^2 - cy^2).
func fitCircleAlgebraic(pts []ringPoint) (ringShape, bool) {
	rows := make([][]float64, 0, len(pts))
	rhs := make([]float64, 0, len(pts))
	for _, p := range pts {
		rows = append(rows, []float64{p.x, p.y, 1})
		rhs = append(rhs, p.x*p.x+p.y*p.y)
	}
	sol, ok := normalEquations(rows, rhs)
	if !ok {
		return ringShape{}, false
	}
	cx := sol[0] / 2
	cy := sol[1] / 2
	r2 := sol[2] + cx*cx + cy*cy
	if !isFinite(r2) || r2 <= 0 {
		return ringShape{}, false
	}
	return ringShape{kind: "circle", cx: cx, cy: cy, r: math.Sqrt(r2)}, true
}

// fitEllipseAlgebraic — осе-ориентированный эллипс ((x-cx)/rx)^2+((y-cy)/ry)^2=1.
// Линеаризация: x^2 = a1*y^2 + a2*x + a3*y + a4, где a1 = -rx^2/ry^2.
func fitEllipseAlgebraic(pts []ringPoint) (ringShape, bool) {
	rows := make([][]float64, 0, len(pts))
	rhs := make([]float64, 0, len(pts))
	for _, p := range pts {
		rows = append(rows, []float64{p.y * p.y, p.x, p.y, 1})
		rhs = append(rhs, p.x*p.x)
	}
	sol, ok := normalEquations(rows, rhs)
	if !ok {
		return ringShape{}, false
	}
	k := -sol[0] // rx^2 / ry^2
	if !isFinite(k) || k <= 1e-6 {
		return ringShape{}, false
	}
	cx := sol[1] / 2
	cy := sol[2] / (2 * k)
	rx2 := sol[3] + cx*cx + k*cy*cy
	if !isFinite(rx2) || rx2 <= 0 {
		return ringShape{}, false
	}
	ry2 := rx2 / k
	if !isFinite(ry2) || ry2 <= 0 {
		return ringShape{}, false
	}
	return ringShape{kind: "ellipse", cx: cx, cy: cy, rx: math.Sqrt(rx2), ry: math.Sqrt(ry2)}, true
}

// refineShape — прямой геометрический МНК поверх алгебраического приближения:
// координатный спуск с уменьшающимся шагом по параметрам формы.
func refineShape(s ringShape, pts []ringPoint) ringShape {
	var params []float64
	var build func(p []float64) ringShape
	if s.kind == "circle" {
		params = []float64{s.cx, s.cy, s.r}
		build = func(p []float64) ringShape {
			return ringShape{kind: "circle", cx: p[0], cy: p[1], r: p[2]}
		}
	} else {
		params = []float64{s.cx, s.cy, s.rx, s.ry}
		build = func(p []float64) ringShape {
			return ringShape{kind: "ellipse", cx: p[0], cy: p[1], rx: p[2], ry: p[3]}
		}
	}

	cost := func(p []float64) float64 {
		cand := build(p)
		if !cand.valid() {
			return math.Inf(1)
		}
		return ringResidual(cand, pts)
	}

	best := cost(params)
	step := 16.0
	for step > 1e-4 {
		improved := false
		for i := range params {
			for _, dir := range []float64{1, -1} {
				trial := append([]float64(nil), params...)
				trial[i] += dir * step
				c := cost(trial)
				if c < best-1e-12 {
					best = c
					params = trial
					improved = true
				}
			}
		}
		if !improved {
			step /= 2
		}
	}
	return build(params)
}

// fitBestRingShape — подбирает окружность и осе-ориентированный эллипс,
// возвращает вариант с меньшей невязкой.
func fitBestRingShape(pts []ringPoint) (ringShape, bool) {
	if len(pts) < 3 {
		return ringShape{}, false
	}

	var best ringShape
	bestRes := math.Inf(1)

	if c, ok := fitCircleAlgebraic(pts); ok {
		c = refineShape(c, pts)
		if res := ringResidual(c, pts); res < bestRes {
			best, bestRes = c, res
		}
	}
	if e, ok := fitEllipseAlgebraic(pts); ok {
		e = refineShape(e, pts)
		if res := ringResidual(e, pts); res < bestRes {
			best, bestRes = e, res
		}
	}
	// Запасной вариант: центроид + средний радиус (как в старом рантайме).
	if math.IsInf(bestRes, 1) {
		var cx, cy float64
		for _, p := range pts {
			cx += p.x
			cy += p.y
		}
		cx /= float64(len(pts))
		cy /= float64(len(pts))
		var rs float64
		for _, p := range pts {
			rs += math.Hypot(p.x-cx, p.y-cy)
		}
		c := ringShape{kind: "circle", cx: cx, cy: cy, r: rs / float64(len(pts))}
		if c.valid() {
			best, bestRes = c, ringResidual(c, pts)
		}
	}
	if !best.valid() {
		return ringShape{}, false
	}
	return best, true
}

// ---------------------------------------------------------------------------
// Раскладка станций по кольцу
// ---------------------------------------------------------------------------

func wrapPi(a float64) float64 {
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	for a <= -math.Pi {
		a += 2 * math.Pi
	}
	return a
}

// ringTrack — станции одной кольцевой линии, упорядоченные по углу на форме.
//
// Важно: порядок здесь угловой, а не порядок stationIds в линии. Разводить
// станции надо именно по угловому соседству — на экране слипаются соседи по
// кольцу, а не по маршруту. Сам stationIds не переставляется.
type ringTrack struct {
	shape ringShape
	ids   []string  // в порядке возрастания угла
	theta []float64 // строго возрастающая последовательность, диапазон < 2pi
	index map[string]int
}

func newRingTrack(shape ringShape, ids []string, stationByID map[string]*FullGraphStation) *ringTrack {
	type entry struct {
		id string
		th float64
	}
	entries := make([]entry, 0, len(ids))
	for _, id := range ids {
		st := stationByID[id]
		if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		th := shape.theta(st.LayoutX, st.LayoutY)
		if !isFinite(th) {
			continue
		}
		// нормализуем в [0, 2pi)
		th = math.Mod(th, 2*math.Pi)
		if th < 0 {
			th += 2 * math.Pi
		}
		entries = append(entries, entry{id: id, th: th})
	}
	if len(entries) < 3 {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].th < entries[j].th })

	track := &ringTrack{
		shape: shape,
		ids:   make([]string, len(entries)),
		theta: make([]float64, len(entries)),
		index: make(map[string]int, len(entries)),
	}
	for i, e := range entries {
		track.ids[i] = e.id
		track.theta[i] = e.th
		track.index[e.id] = i
	}
	return track
}

func (t *ringTrack) pos(i int) (float64, float64) {
	return t.shape.at(t.theta[i])
}

func (t *ringTrack) posAt(v float64) (float64, float64) {
	return t.shape.at(v)
}

func (t *ringTrack) writeBack(stationByID map[string]*FullGraphStation) {
	for i, id := range t.ids {
		st := stationByID[id]
		if st == nil {
			continue
		}
		x, y := t.pos(i)
		if isFinite(x) && isFinite(y) {
			st.LayoutX = x
			st.LayoutY = y
		}
	}
}

// minDeltaTheta — минимальный угловой зазор, соответствующий хорде minChord,
// в окрестности угла v.
func (t *ringTrack) minDeltaTheta(v float64, minChord float64) float64 {
	scale := t.shape.arcScale(v)
	if !isFinite(scale) || scale <= 1e-6 {
		return 0
	}
	return minChord / scale
}

// declump — разводит соседние станции вдоль кольца (только по углу), если после
// проекции они оказались ближе minChord.
func (t *ringTrack) declump(minChord float64, iterations int) {
	n := len(t.theta)
	if n < 3 {
		return
	}
	for it := 0; it < iterations; it++ {
		moved := false
		for i := 0; i < n; i++ {
			j := (i + 1) % n
			gap := t.theta[j] - t.theta[i]
			if j == 0 {
				gap = t.theta[0] + 2*math.Pi - t.theta[n-1]
			}
			mid := t.theta[i] + gap/2
			need := t.minDeltaTheta(mid, minChord)
			if gap >= need || need <= 0 {
				continue
			}
			deficit := (need - gap) / 2
			t.theta[i] -= deficit
			t.theta[j] += deficit
			moved = true
		}
		// Восстанавливаем монотонность после циклических сдвигов.
		sort.Float64s(t.theta)
		if !moved {
			break
		}
	}
}

// bounds — допустимый интервал угла для станции i с учётом соседей и
// максимального сдвига вдоль дуги.
func (t *ringTrack) bounds(i int, minChord, maxArcShift float64) (lo, hi float64) {
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
	need := t.minDeltaTheta(cur, minChord)
	lo = prev + need
	hi = next - need
	scale := t.shape.arcScale(cur)
	if isFinite(scale) && scale > 1e-6 {
		d := maxArcShift / scale
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

// ---------------------------------------------------------------------------
// Главный проход
// ---------------------------------------------------------------------------

type ringPassStat struct {
	LineID   int
	Kind     string
	RMS      float64
	MeanDev  float64
	MaxDev   float64
	Stations int
}

// ApplyRingProjection подгоняет форму каждой кольцевой линии, проецирует на неё
// станции, согласует пересадочные хабы и записывает формы в graph.RingShapes.
// ApplyRingProjection подгоняет форму каждого кольца, проецирует на неё станции
// и публикует форму в ringShapes.
//
// shapeOverrides — формы, заданные вручную в редакторе (см. ringShapeOverrides).
// Заданная форма заменяет автоматическую подгонку: она и станет опубликованной,
// и станции спроецируются именно на неё, так что rings.shapeFitError и
// rings.projectionError* остаются нулевыми в обоих случаях.
func ApplyRingProjection(graph *FullGraphExport, shapeOverrides map[int]ringShape) []ringPassStat {
	if graph == nil {
		return nil
	}

	stationByID := make(map[string]*FullGraphStation, len(graph.Stations))
	for i := range graph.Stations {
		st := &graph.Stations[i]
		stationByID[st.ID] = st
	}

	tracks := make(map[int]*ringTrack)
	shapes := make(map[int]ringShape)
	stats := make([]ringPassStat, 0, len(ringLineIDs))

	for i := range graph.Lines {
		ln := &graph.Lines[i]
		if _, isRing := ringLineIDs[ln.ID]; !isRing {
			continue
		}
		pts := make([]ringPoint, 0, len(ln.StationIDs))
		for _, sid := range ln.StationIDs {
			st := stationByID[sid]
			if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
				continue
			}
			pts = append(pts, ringPoint{st.LayoutX, st.LayoutY})
		}
		shape, ok := shapeOverrides[ln.ID]
		kind := shape.kind + " (ручная форма)"
		if ok && !shape.valid() {
			ok = false
		}
		if !ok {
			shape, ok = fitBestRingShape(pts)
			if !ok {
				continue
			}
			kind = shape.kind + " fit"
		}
		mean, max := ringMeanMaxDev(shape, pts)
		stats = append(stats, ringPassStat{
			LineID:   ln.ID,
			Kind:     kind,
			RMS:      ringResidual(shape, pts),
			MeanDev:  mean,
			MaxDev:   max,
			Stations: len(pts),
		})

		track := newRingTrack(shape, ln.StationIDs, stationByID)
		shapes[ln.ID] = shape
		if track != nil {
			tracks[ln.ID] = track
		} else {
			// Порядок станций не годится для работы по углу — просто проецируем.
			for _, sid := range ln.StationIDs {
				st := stationByID[sid]
				if st == nil {
					continue
				}
				x, y := shape.project(st.LayoutX, st.LayoutY)
				if isFinite(x) && isFinite(y) {
					st.LayoutX = x
					st.LayoutY = y
				}
			}
		}
	}

	if len(shapes) == 0 {
		return stats
	}

	// Запоминаем позиции до прохода — по ним двигаем «свиту» хабов.
	prev := make(map[string]ringPoint, len(graph.Stations))
	for id, st := range stationByID {
		prev[id] = ringPoint{st.LayoutX, st.LayoutY}
	}

	// (б) проекция + (г) разведение вдоль кольца.
	// Обход в порядке id линии — результат прохода не должен зависеть от
	// порядка обхода map.
	trackLineIDs := make([]int, 0, len(tracks))
	for id := range tracks {
		trackLineIDs = append(trackLineIDs, id)
	}
	sort.Ints(trackLineIDs)
	for _, id := range trackLineIDs {
		t := tracks[id]
		t.declump(ringMinChordPx, 200)
		t.writeBack(stationByID)
	}

	// Жёсткие группы станций: хаб целиком + станции, стоявшие в одной точке.
	clusters := buildStationClusters(graph, stationByID, prev)

	// (в) согласование хабов
	resolveRingHubs(clusters, stationByID, tracks, prev)

	// (г, продолжение) сдвинувшееся кольцо могло подъехать вплотную к чужой
	// станции — расталкиваем только некольцевые группы, кольца не трогаем.
	separateFromRings(clusters, graph, stationByID, tracks, ringMinChordPx)

	// (г2) станции, налезшие на чужие линии и друг на друга. Формы колец здесь
	// уже зафиксированы: кольцевые станции двигаются только вдоль кольца.
	ApplySeparation(graph, tracks)

	// (д) публикация форм
	out := make(map[string]FullGraphRingShape, len(shapes))
	for lineID, s := range shapes {
		key := strconv.Itoa(lineID)
		if s.kind == "circle" {
			r := s.r
			out[key] = FullGraphRingShape{Kind: "circle", Cx: s.cx, Cy: s.cy, R: &r}
		} else {
			rx, ry := s.rx, s.ry
			out[key] = FullGraphRingShape{Kind: "ellipse", Cx: s.cx, Cy: s.cy, Rx: &rx, Ry: &ry}
		}
	}
	graph.RingShapes = out

	sort.Slice(stats, func(i, j int) bool { return stats[i].LineID < stats[j].LineID })
	return stats
}

// resolveRingHubs согласует пересадочные хабы после проекции.
//
// Группа («кластер») — это пересадочный хаб плюс станции, стоявшие до прохода
// в той же точке (одна физическая станция, разнесённая по двум хабам).
//
//   - в хабе одна кольцевая линия: кольцевая станция остаётся на кольце,
//     остальные станции хаба сдвигаются на тот же вектор (взаимное расположение
//     внутри хаба, нарисованное вручную, сохраняется);
//   - в хабе две и более кольцевых линий: обе станции сдвигаются вдоль своих
//     колец навстречу друг другу (угол меняется, форма — нет), сдвиг ограничен
//     соседями по кольцу и ringHubMaxArcShiftPx; свита едет за средним сдвигом.
func resolveRingHubs(
	clusters [][]string,
	stationByID map[string]*FullGraphStation,
	tracks map[int]*ringTrack,
	prev map[string]ringPoint,
) {
	type member struct {
		id    string
		track *ringTrack
		idx   int
	}

	for _, cluster := range clusters {
		if len(cluster) < 2 {
			continue
		}

		ringMembers := make([]member, 0, 2)
		followers := make([]string, 0, len(cluster))
		for _, sid := range cluster {
			st := stationByID[sid]
			if st == nil {
				continue
			}
			t := tracks[st.LineNumericID]
			if t != nil {
				if idx, ok := t.index[sid]; ok {
					ringMembers = append(ringMembers, member{id: sid, track: t, idx: idx})
					continue
				}
			}
			followers = append(followers, sid)
		}
		if len(ringMembers) == 0 {
			continue
		}

		// Конфликт: несколько кольцевых линий в одном хабе — сближаем их
		// вдоль колец.
		if len(ringMembers) > 1 {
			for iter := 0; iter < 40; iter++ {
				var tx, ty float64
				for _, m := range ringMembers {
					x, y := m.track.pos(m.idx)
					tx += x
					ty += y
				}
				tx /= float64(len(ringMembers))
				ty /= float64(len(ringMembers))

				movedAny := false
				for _, m := range ringMembers {
					lo, hi2 := m.track.bounds(m.idx, ringMinChordPx, ringHubMaxArcShiftPx)
					best := m.track.theta[m.idx]
					x, y := m.track.posAt(best)
					bestD := math.Hypot(x-tx, y-ty)
					const samples = 64
					for s := 0; s <= samples; s++ {
						v := lo + (hi2-lo)*float64(s)/float64(samples)
						px, py := m.track.posAt(v)
						d := math.Hypot(px-tx, py-ty)
						if d < bestD-1e-9 {
							bestD = d
							best = v
						}
					}
					if best != m.track.theta[m.idx] {
						m.track.theta[m.idx] = best
						movedAny = true
					}
				}
				if !movedAny {
					break
				}
			}
			for _, m := range ringMembers {
				m.track.writeBack(stationByID)
			}
		}

		// Свита: сдвигаем на средний вектор смещения кольцевых станций хаба,
		// сохраняя нарисованные вручную относительные смещения.
		if len(followers) == 0 {
			continue
		}
		var dx, dy float64
		for _, m := range ringMembers {
			st := stationByID[m.id]
			p := prev[m.id]
			dx += st.LayoutX - p.x
			dy += st.LayoutY - p.y
		}
		dx /= float64(len(ringMembers))
		dy /= float64(len(ringMembers))
		if !isFinite(dx) || !isFinite(dy) {
			continue
		}
		for _, sid := range followers {
			st := stationByID[sid]
			if st == nil {
				continue
			}
			st.LayoutX += dx
			st.LayoutY += dy
		}
	}
}

// separateFromRings расталкивает станции, оказавшиеся ближе minSep друг к другу
// после сдвига колец.
//
// Кольцевые станции неподвижны (они уже лежат ровно на форме и разведены по
// углу), двигаются только некольцевые группы. Группа = пересадочный хаб целиком
// либо одиночная станция: хаб двигается как жёсткое целое, чтобы не разъехался.
func separateFromRings(
	groups [][]string,
	graph *FullGraphExport,
	stationByID map[string]*FullGraphStation,
	tracks map[int]*ringTrack,
	minSep float64,
) {
	const maxShiftPx = 24.0

	groupOf := make(map[string]int, len(graph.Stations))
	for gi, members := range groups {
		for _, sid := range members {
			groupOf[sid] = gi
		}
	}

	// Группа «закреплена», если содержит станцию кольца.
	pinned := make([]bool, len(groups))
	for gi, members := range groups {
		for _, sid := range members {
			st := stationByID[sid]
			if st == nil {
				continue
			}
			if t := tracks[st.LineNumericID]; t != nil {
				if _, ok := t.index[sid]; ok {
					pinned[gi] = true
					break
				}
			}
		}
	}

	shifted := make([]ringPoint, len(groups))
	move := func(gi int, dx, dy float64) {
		nx := shifted[gi].x + dx
		ny := shifted[gi].y + dy
		if math.Hypot(nx, ny) > maxShiftPx {
			return
		}
		shifted[gi] = ringPoint{nx, ny}
		for _, sid := range groups[gi] {
			if st := stationByID[sid]; st != nil {
				st.LayoutX += dx
				st.LayoutY += dy
			}
		}
	}

	stations := graph.Stations
	for iter := 0; iter < 60; iter++ {
		worst := 0.0
		for i := range stations {
			a := stationByID[stations[i].ID]
			if a == nil {
				continue
			}
			gi := groupOf[a.ID]
			for j := i + 1; j < len(stations); j++ {
				b := stationByID[stations[j].ID]
				if b == nil {
					continue
				}
				gj := groupOf[b.ID]
				if gi == gj {
					continue
				}
				if pinned[gi] && pinned[gj] {
					continue
				}
				dx := b.LayoutX - a.LayoutX
				dy := b.LayoutY - a.LayoutY
				d := math.Hypot(dx, dy)
				if d >= minSep {
					continue
				}
				if d < 1e-6 {
					dx, dy, d = 1, 0, 1
				}
				need := minSep - d
				if need > worst {
					worst = need
				}
				ux := dx / d
				uy := dy / d
				switch {
				case pinned[gi]:
					move(gj, ux*need, uy*need)
				case pinned[gj]:
					move(gi, -ux*need, -uy*need)
				default:
					move(gi, -ux*need/2, -uy*need/2)
					move(gj, ux*need/2, uy*need/2)
				}
			}
		}
		if worst < 0.05 {
			break
		}
	}
}

// buildStationClusters группирует станции, которые должны двигаться как единое
// целое: члены одного пересадочного хаба, а также станции, стоявшие до прохода
// в одной точке (одна физическая станция, разложенная по двум хабам, — например
// Бульвар Рокоссовского). Остальные станции образуют группы из самих себя.
//
// Порядок групп и станций внутри них детерминирован и не зависит от порядка
// обхода map или порядка graph.TransferHubs.
func buildStationClusters(
	graph *FullGraphExport,
	stationByID map[string]*FullGraphStation,
	prev map[string]ringPoint,
) [][]string {
	const coincidentPx = 2.0

	parent := make(map[string]string, len(graph.Stations))
	var find func(string) string
	find = func(a string) string {
		p, ok := parent[a]
		if !ok || p == a {
			return a
		}
		r := find(p)
		parent[a] = r
		return r
	}
	union := func(a, b string) {
		ra, rb := find(a), find(b)
		if ra == rb {
			return
		}
		if ra < rb {
			parent[rb] = ra
		} else {
			parent[ra] = rb
		}
	}

	ids := make([]string, 0, len(graph.Stations))
	for i := range graph.Stations {
		id := graph.Stations[i].ID
		parent[id] = id
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, hub := range graph.TransferHubs {
		for i := 1; i < len(hub.StationIDs); i++ {
			a, b := hub.StationIDs[0], hub.StationIDs[i]
			if stationByID[a] == nil || stationByID[b] == nil {
				continue
			}
			union(a, b)
		}
	}

	for i := 0; i < len(ids); i++ {
		pa, ok := prev[ids[i]]
		if !ok {
			continue
		}
		for j := i + 1; j < len(ids); j++ {
			pb, ok := prev[ids[j]]
			if !ok {
				continue
			}
			if math.Hypot(pa.x-pb.x, pa.y-pb.y) <= coincidentPx {
				union(ids[i], ids[j])
			}
		}
	}

	byRoot := make(map[string][]string)
	roots := make([]string, 0)
	for _, id := range ids {
		r := find(id)
		if _, seen := byRoot[r]; !seen {
			roots = append(roots, r)
		}
		byRoot[r] = append(byRoot[r], id)
	}
	sort.Strings(roots)

	out := make([][]string, 0, len(roots))
	for _, r := range roots {
		out = append(out, byRoot[r])
	}
	return out
}
