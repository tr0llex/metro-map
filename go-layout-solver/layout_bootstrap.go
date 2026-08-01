// Автоматическая раскладка схемы «с нуля» — путь холодного старта.
//
// ЧТО ЭТО. Единственный код в проекте, умеющий расставить станции без ручной
// раскладки: проекция lat/lon на плоскость, притягивание к Яндекс-якорям
// (applyYandexAnchors), выпрямление колец (enforceRing), сжатие пересадочных
// хабов (snapAllTransferHubs), октолинейные коридоры, сглаживание, разведение
// слишком близких станций и центрирование.
//
// КОГДА РАБОТАЕТ. Только когда в editor_overrides.json нет секции layout
// (см. main.go: вызов ApplyLayout обёрнут в `if len(editorOv.Layout) == 0`).
// Это новая линия без ручной раскладки, другой город, потеря или намеренный
// сброс editor_overrides.json.
//
// ПОЧЕМУ СЕЙЧАС НЕ РАБОТАЕТ. На текущих данных в editor_overrides.json лежат
// координаты всех 306 станций схемы, и ApplyLayoutOverrides перезаписывает
// LayoutX/LayoutY поголовно. То есть результат этого файла до последнего
// байта затирался следующим же шагом: замена тела ApplyLayout на `return nil`
// давала побайтово идентичный fullGraph.json. Код не мёртв по смыслу — он
// мёртв по данным, поэтому он изолирован, а не удалён, и вызов сделан явно
// условным, чтобы из main.go было видно, что это ветка холодного старта.
//
// КАК ПРОВЕРИТЬ, ЧТО ОН ЖИВ. Собрать граф без ручной раскладки и посмотреть
// на геометрию (из каталога go-layout-solver):
//
//	go run . -csv ../new_map_source/metro.ru.csv \
//	         -connections ../new_map_source/connections.json \
//	         -yandex ../normalized/yandex_coords.json \
//	         -out /tmp/coldstart.json
//
// (то же самое — с -editor_overrides на файл, где "layout" пуст: тогда
// проверяются ещё и station/line/edge-оверрайды). Ожидание: команда
// отрабатывает без ошибок, у всех станций конечные layoutX/layoutY, разброс
// координат сопоставим с боевым файлом, кольцевые линии садятся на форму.
// НЕ перезаписывайте этим normalized/fullGraph.json.
package main

import (
	"fmt"
	"math"
	"sort"
)

// ApplyLayout заполняет LayoutX/LayoutY для всех станций графа.
// Алгоритм ориентирован на схему вида «кольца + хорды» и использует
// географические координаты только как ориентир.
//
// Вызывается только при холодном старте — см. заголовок файла.
func ApplyLayout(graph *FullGraphExport) error {
	if graph == nil {
		return fmt.Errorf("nil graph")
	}

	stationMap := make(map[string]*FullGraphStation, len(graph.Stations))
	for i := range graph.Stations {
		st := &graph.Stations[i]
		stationMap[st.ID] = st
	}

	// Проверяем, есть ли в графе станции с координатами Яндекса.
	hasYandex := false
	for _, st := range graph.Stations {
		if isFinite(st.YandexX) && isFinite(st.YandexY) {
			hasYandex = true
			break
		}
	}

	// 1. Базовая проекция lat/lon -> плоская карта
	minLat, maxLat, minLon, maxLon := boundsLatLon(graph.Stations)
	if !isFinite(minLat) {
		return fmt.Errorf("no finite coordinates for layout")
	}

	const baseWidth = 2400.0
	const baseHeight = 1800.0

	for i := range graph.Stations {
		st := &graph.Stations[i]
		if !isFinite(st.Lat) || !isFinite(st.Lon) {
			continue
		}
		nx := (st.Lon - minLon) / (maxLon - minLon)
		ny := (st.Lat - minLat) / (maxLat - minLat)
		st.LayoutX = nx * baseWidth
		st.LayoutY = (1 - ny) * baseHeight
	}

	// 1b. Если есть координаты Яндекса, используем их как основной якорь для layout:
	// подбираем глобальный scale + сдвиг из системы Яндекса в текущие layout-координаты
	// и жёстко (alpha=1) переносим станции с Яндекс-координатами в эти позиции.
	//
	// enforceRing вызывается РОВНО ОДИН РАЗ на каждой ветке. Раньше он стоял
	// ещё и здесь, до развилки, и в Яндекс-режиме отрабатывал дважды: сначала
	// раздувал кольца поверх географической проекции, потом — поверх уже
	// раздутых координат. Карта получалась 24954×20100 px вместо ~1500×1800.
	if hasYandex {
		applyYandexAnchors(stationMap, 1.0)
		enforceRing(&graph.Lines, stationMap)
		// Даже в Яндекс-режиме слегка уплотняем пересадочные хабы: все станции
		// внутри одного хаба должны оказаться в одной точке, чтобы визуально
		// восприниматься как единый пересадочный узел.
		snapAllTransferHubs(graph.TransferHubs, stationMap)

		// Лёгкое раздвижение слишком близких станций поверх Яндекс-геометрии.
		// Используем меньшие пороги, чем в чисто эвристическом режиме, чтобы
		// не сильно отходить от референсной схемы, но убрать самые критичные
		// случаи (d < ~8–16px).
		optimizeDistances(stationMap, 8, 16, 4)
		snapAllTransferHubs(graph.TransferHubs, stationMap)
	} else {
		// 2–5. Геометрические правки (хабы, сглаживание, раздвижение) применяем
		// только если нет координат Яндекса. В этом режиме layout строится
		// эвристически поверх географической проекции.
		enforceRing(&graph.Lines, stationMap)

		// 2. Компактизируем хабы, отдавая приоритет станциям на кольцах
		snapAllTransferHubs(graph.TransferHubs, stationMap)

		explodeInnerStationsAroundRing(&graph.Lines, stationMap)

		applyOctilinearCorridors(&graph.Lines, stationMap)

		applyOctilinearLayout(&graph.Lines, stationMap)

		smoothNonRingLines(&graph.Lines, stationMap, 12)

		optimizeDistances(stationMap, 30, 50, 50)

		snapAllTransferHubs(graph.TransferHubs, stationMap)

		smoothNonRingLines(&graph.Lines, stationMap, 10)
	}

	// 6. Масштабируем под целевой размер (только центрирование)
	scaleEntireMap(stationMap)

	return nil
}

func boundsLatLon(stations []FullGraphStation) (minLat, maxLat, minLon, maxLon float64) {
	minLat = math.Inf(1)
	maxLat = math.Inf(-1)
	minLon = math.Inf(1)
	maxLon = math.Inf(-1)
	for _, s := range stations {
		if !isFinite(s.Lat) || !isFinite(s.Lon) {
			continue
		}
		if s.Lat < minLat {
			minLat = s.Lat
		}
		if s.Lat > maxLat {
			maxLat = s.Lat
		}
		if s.Lon < minLon {
			minLon = s.Lon
		}
		if s.Lon > maxLon {
			maxLon = s.Lon
		}
	}
	return
}

// applyYandexAnchors подбирает глобальное аффинное преобразование вида
//
//	X_layout ≈ scale * (X_yandex - cx_src) + cx_dst
//	Y_layout ≈ scale * (Y_yandex - cy_src) + cy_dst
//
// по всем станциям, для которых есть и layout-, и Yandex-координаты,
// а затем мягко смешивает текущий layout с целевой позицией с весом alpha.
// alpha в диапазоне [0,1] задаёт силу притягивания к схеме Яндекса.
func applyYandexAnchors(stationMap map[string]*FullGraphStation, alpha float64) {
	if stationMap == nil {
		return
	}
	if alpha <= 0 {
		return
	}
	if alpha > 1 {
		alpha = 1
	}

	minYx := math.Inf(1)
	maxYx := math.Inf(-1)
	minYy := math.Inf(1)
	maxYy := math.Inf(-1)
	minLx := math.Inf(1)
	maxLx := math.Inf(-1)
	minLy := math.Inf(1)
	maxLy := math.Inf(-1)

	count := 0
	for _, st := range stationMap {
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		if !isFinite(st.YandexX) || !isFinite(st.YandexY) {
			continue
		}

		yx := st.YandexX
		yy := st.YandexY
		lx := st.LayoutX
		ly := st.LayoutY

		if yx < minYx {
			minYx = yx
		}
		if yx > maxYx {
			maxYx = yx
		}
		if yy < minYy {
			minYy = yy
		}
		if yy > maxYy {
			maxYy = yy
		}

		if lx < minLx {
			minLx = lx
		}
		if lx > maxLx {
			maxLx = lx
		}
		if ly < minLy {
			minLy = ly
		}
		if ly > maxLy {
			maxLy = ly
		}

		count++
	}

	// Если станций с координатами Яндекса мало или bbox вырожден — ничего не делаем.
	if count < 10 {
		return
	}
	if !isFinite(minYx) || !isFinite(maxYx) || !isFinite(minYy) || !isFinite(maxYy) {
		return
	}
	if !isFinite(minLx) || !isFinite(maxLx) || !isFinite(minLy) || !isFinite(maxLy) {
		return
	}

	srcW := maxYx - minYx
	srcH := maxYy - minYy
	dstW := maxLx - minLx
	dstH := maxLy - minLy
	if srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0 {
		return
	}

	srcCx := (minYx + maxYx) / 2
	srcCy := (minYy + maxYy) / 2
	dstCx := (minLx + maxLx) / 2
	dstCy := (minLy + maxLy) / 2

	scaleX := dstW / srcW
	scaleY := dstH / srcH
	scale := math.Min(scaleX, scaleY)
	if !isFinite(scale) || scale <= 0 {
		return
	}

	for _, st := range stationMap {
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		if !isFinite(st.YandexX) || !isFinite(st.YandexY) {
			continue
		}

		// Переносим точку из Yandex-системы в layout-систему через общий scale+shift
		dx := (st.YandexX - srcCx) * scale
		dy := (st.YandexY - srcCy) * scale
		targetX := dstCx + dx
		targetY := dstCy + dy

		st.LayoutX = st.LayoutX*(1-alpha) + targetX*alpha
		st.LayoutY = st.LayoutY*(1-alpha) + targetY*alpha
	}
}

// --- Кольца ---

// ringRadiusFraction — доля от габарита схемы (меньшей стороны bbox всех
// станций), которую занимает радиус кольца.
//
// Раньше здесь стояли множители к текущему радиусу (7.0 / 6.0 / 7.5). Множитель
// не идемпотентен: он зависит от того, сколько раз функцию уже вызвали, и
// раздувает карту без всякой связи с её реальным размером. Доля от габарита
// такой связи не теряет — сколько бы раз проход ни отработал, кольцо встаёт на
// одно и то же место относительно схемы.
//
// Значения подобраны по боевой схеме (normalized/fullGraph.json): при габарите
// 1527×1771 радиусы колец равны 280 / 503 / 554 px, то есть 0.18 / 0.33 / 0.36
// от меньшей стороны.
var ringRadiusFraction = map[int]float64{
	5:  0.18, // Кольцевая
	95: 0.33, // МЦК
	97: 0.36, // БКЛ
}

// mapSpan возвращает меньшую сторону bbox всех станций с конечными
// координатами. Ноль означает «габарит неизвестен» — тогда нормировать не по
// чему и радиусы колец остаются такими, какие есть.
func mapSpan(stationMap map[string]*FullGraphStation) float64 {
	minX, maxX := math.Inf(1), math.Inf(-1)
	minY, maxY := math.Inf(1), math.Inf(-1)
	for _, st := range stationMap {
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		minX = math.Min(minX, st.LayoutX)
		maxX = math.Max(maxX, st.LayoutX)
		minY = math.Min(minY, st.LayoutY)
		maxY = math.Max(maxY, st.LayoutY)
	}
	if !isFinite(minX) || !isFinite(minY) {
		return 0
	}
	span := math.Min(maxX-minX, maxY-minY)
	if !isFinite(span) || span <= 0 {
		return 0
	}
	return span
}

// placeOnRing сажает станции кольца на эллипс (rx, ry) вокруг (cx, cy),
// СОХРАНЯЯ угол каждой станции.
//
// Раньше углы назначались по индексу в списке (2πi/n) — кольцо получалось
// идеально равномерным, но полностью терявшим связь с географией: станция
// уезжала на произвольную дугу. Хуже того, две кольцевые линии в одном
// пересадочном узле (Шелепиха на МЦК и БКЛ) расходились по разным углам, и узел
// разъезжался — 126 px при пороге метрики hubs.notMerged в ~37 px.
// Собственный угол станции сохраняет и порядок, и узлы.
func placeOnRing(ids []string, stationMap map[string]*FullGraphStation, cx, cy, rx, ry float64) {
	for _, sid := range ids {
		st := stationMap[sid]
		if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		dx := st.LayoutX - cx
		dy := st.LayoutY - cy
		if math.Hypot(dx, dy) < 1e-9 {
			continue
		}
		angle := math.Atan2(dy, dx)
		st.LayoutX = cx + rx*math.Cos(angle)
		st.LayoutY = cy + ry*math.Sin(angle)
	}
}

func enforceRing(lines *[]FullGraphLine, stationMap map[string]*FullGraphStation) {
	if lines == nil {
		return
	}

	// Габарит считается ОДИН раз, до цикла: иначе каждое обработанное кольцо
	// сдвигало бы точку отсчёта для следующего, и результат зависел бы от
	// порядка линий.
	span := mapSpan(stationMap)

	for _, line := range *lines {
		if _, isRing := ringLineIDs[line.ID]; !isRing {
			continue
		}
		// Собираем текущие координаты кольцевых станций
		pts := make([]*FullGraphStation, 0, len(line.StationIDs))
		for _, sid := range line.StationIDs {
			st := stationMap[sid]
			if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
				continue
			}
			pts = append(pts, st)
		}
		if len(pts) < 3 {
			continue
		}

		var cx, cy float64
		for _, p := range pts {
			cx += p.LayoutX
			cy += p.LayoutY
		}
		cx /= float64(len(pts))
		cy /= float64(len(pts))

		var rSum float64
		var sumDx2, sumDy2 float64
		for _, p := range pts {
			dx := p.LayoutX - cx
			dy := p.LayoutY - cy
			r := math.Hypot(dx, dy)
			rSum += r
			sumDx2 += dx * dx
			sumDy2 += dy * dy
		}
		baseR := rSum / float64(len(pts))
		if !isFinite(baseR) || baseR <= 0 {
			continue
		}

		// Радиус кольца — доля от габарита схемы. Кольца надо развести между
		// собой, чтобы освободить центр, но привязка к габариту не даёт им
		// уехать за пределы карты.
		targetR := baseR
		if frac, ok := ringRadiusFraction[line.ID]; ok && span > 0 {
			targetR = span * frac
		}
		radiusScale := targetR / baseR

		// Для БКЛ используем эллипс, выровненный по осям X/Y, а не окружность.
		if line.ID == 97 {
			varX := sumDx2 / float64(len(pts))
			varY := sumDy2 / float64(len(pts))
			if isFinite(varX) && isFinite(varY) && varX > 0 && varY > 0 {
				ratio := math.Sqrt(varX / varY) // соотношение осей по дисперсиям
				if ratio < 1.1 {
					ratio = 1.1
				} else if ratio > 3.0 {
					ratio = 3.0
				}

				// Усреднённый «круговой» радиус, как раньше, но теперь распределяем его по осям эллипса.
				rCircle := baseR * radiusScale
				den := math.Sqrt((ratio*ratio + 1) / 2) // чтобы rx, ry не раздували карту чрезмерно
				if den <= 0 {
					continue
				}
				s := rCircle / den
				rx := ratio * s
				ry := s

				placeOnRing(line.StationIDs, stationMap, cx, cy, rx, ry)
				continue
			}
		}

		// Для остальных колец оставляем окружность.
		r := baseR * radiusScale
		placeOnRing(line.StationIDs, stationMap, cx, cy, r, r)
	}
}

// applyOctilinearCorridors раскладывает станции между якорями линии (пересадки и концы)
// вдоль одного защёлкнутого октолинейного направления, чтобы формировать длинные
// прямолинейные участки в духе схемы Яндекс.Метро.
func applyOctilinearCorridors(lines *[]FullGraphLine, stationMap map[string]*FullGraphStation) {
	if lines == nil {
		return
	}

	for _, line := range *lines {
		if _, isRing := ringLineIDs[line.ID]; isRing {
			continue
		}
		ids := line.StationIDs
		if len(ids) < 3 {
			continue
		}

		// Индексы якорей: концы линии и пересадочные станции внутри
		anchorIdx := []int{0}
		for i := 1; i < len(ids)-1; i++ {
			st := stationMap[ids[i]]
			if st != nil && st.IsTransfer {
				anchorIdx = append(anchorIdx, i)
			}
		}
		anchorIdx = append(anchorIdx, len(ids)-1)

		if len(anchorIdx) < 2 {
			continue
		}

		for a := 0; a < len(anchorIdx)-1; a++ {
			fromIdx := anchorIdx[a]
			toIdx := anchorIdx[a+1]
			if toIdx-fromIdx < 2 {
				continue
			}

			fromSt := stationMap[ids[fromIdx]]
			toSt := stationMap[ids[toIdx]]
			if fromSt == nil || toSt == nil {
				continue
			}
			if !isFinite(fromSt.LayoutX) || !isFinite(fromSt.LayoutY) ||
				!isFinite(toSt.LayoutX) || !isFinite(toSt.LayoutY) {
				continue
			}

			vx := toSt.LayoutX - fromSt.LayoutX
			vy := toSt.LayoutY - fromSt.LayoutY
			segLen := math.Hypot(vx, vy)
			if segLen < 1e-3 {
				continue
			}

			baseAngle := math.Atan2(vy, vx)
			snapped := snapOctilinearAngle(baseAngle)
			ux, uy := math.Cos(snapped), math.Sin(snapped)

			for i := fromIdx + 1; i < toIdx; i++ {
				st := stationMap[ids[i]]
				if st == nil || st.IsTransfer { // пересадки держим ближе к хабам
					continue
				}
				if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
					continue
				}

				t := float64(i-fromIdx) / float64(toIdx-fromIdx)
				if t < 0 {
					t = 0
				} else if t > 1 {
					t = 1
				}

				targetX := fromSt.LayoutX + ux*segLen*t
				targetY := fromSt.LayoutY + uy*segLen*t

				alpha := 0.85
				st.LayoutX = st.LayoutX*(1-alpha) + targetX*alpha
				st.LayoutY = st.LayoutY*(1-alpha) + targetY*alpha
			}
		}
	}
}

// --- Октолинейный layout радиальных линий ---

// snapOctilinearAngle возвращает угол, защёлкнутый к ближайшему значению 0/45/90/135/... градусов.
func snapOctilinearAngle(a float64) float64 {
	const step = math.Pi / 4 // 45°
	k := math.Round(a / step)
	return k * step
}

// applyOctilinearLayout старается сделать ломаные не-кольцевых линий близкими к октолинейным,
// сдвигая промежуточные станции к пересечению «идеальных» направлений.
func applyOctilinearLayout(lines *[]FullGraphLine, stationMap map[string]*FullGraphStation) {
	if lines == nil {
		return
	}

	// Локальная правка: работаем только с точками, где угол действительно резкий.
	const maxShift = 60.0 // максимально допустимый сдвиг одной станции за одну итерацию

	for _, line := range *lines {
		if _, isRing := ringLineIDs[line.ID]; isRing {
			continue
		}
		ids := line.StationIDs
		if len(ids) < 3 {
			continue
		}

		for i := 1; i < len(ids)-1; i++ {
			cur := stationMap[ids[i]]
			prev := stationMap[ids[i-1]]
			next := stationMap[ids[i+1]]
			if cur == nil || prev == nil || next == nil {
				continue
			}
			if !isFinite(cur.LayoutX) || !isFinite(cur.LayoutY) ||
				!isFinite(prev.LayoutX) || !isFinite(prev.LayoutY) ||
				!isFinite(next.LayoutX) || !isFinite(next.LayoutY) {
				continue
			}

			// Не трогаем пересадочные станции — их положение дополнительно фиксируется снапом хабов.
			if cur.IsTransfer {
				continue
			}

			// Сначала оцениваем текущий угол. Если он не резкий, станцию не трогаем.
			oldAngle := angleDeg(prev, cur, next)
			if oldAngle <= 120 { // нас интересуют только очень резкие изломы
				continue
			}

			dx1 := cur.LayoutX - prev.LayoutX
			dy1 := cur.LayoutY - prev.LayoutY
			dx2 := next.LayoutX - cur.LayoutX
			dy2 := next.LayoutY - cur.LayoutY
			if math.Hypot(dx1, dy1) < 1e-3 || math.Hypot(dx2, dy2) < 1e-3 {
				continue
			}

			a1 := math.Atan2(dy1, dx1)
			a2 := math.Atan2(dy2, dx2)
			a1s := snapOctilinearAngle(a1)
			a2s := snapOctilinearAngle(a2)

			u1x, u1y := math.Cos(a1s), math.Sin(a1s)
			u2x, u2y := math.Cos(a2s), math.Sin(a2s)

			vx := next.LayoutX - prev.LayoutX
			vy := next.LayoutY - prev.LayoutY

			// Пытаемся найти точку пересечения лучей:
			// prev + t1*u1 = next - t2*u2
			// => t1*u1 + t2*u2 = next - prev
			det := u1x*u2y - u1y*u2x
			var px, py float64
			ok := false

			if math.Abs(det) > 1e-3 {
				t1 := (vx*u2y - vy*u2x) / det
				t2 := (u1x*vy - u1y*vx) / det
				if t1 > 0 && t2 > 0 {
					px = prev.LayoutX + t1*u1x
					py = prev.LayoutY + t1*u1y
					ok = true
				}
			}

			if !ok {
				// Fallback: защёлкиваем направление общего сегмента prev-next и
				// переносим текущую станцию на этот луч, сохраняя её относительную долю пути.
				ad := math.Atan2(vy, vx)
				ads := snapOctilinearAngle(ad)
				ux, uy := math.Cos(ads), math.Sin(ads)
				dPN := math.Hypot(vx, vy)
				if dPN < 1e-3 {
					continue
				}
				dPrevCur := math.Hypot(cur.LayoutX-prev.LayoutX, cur.LayoutY-prev.LayoutY)
				f := dPrevCur / dPN
				if f < 0 {
					f = 0
				} else if f > 1 {
					f = 1
				}
				px = prev.LayoutX + ux*dPN*f
				py = prev.LayoutY + uy*dPN*f
			}

			// Ограничиваем величину сдвига, чтобы не «улететь» далеко от исходной позиции.
			shift := math.Hypot(px-cur.LayoutX, py-cur.LayoutY)
			if shift > maxShift {
				k := maxShift / shift
				px = cur.LayoutX + (px-cur.LayoutX)*k
				py = cur.LayoutY + (py-cur.LayoutY)*k
			}

			// Проверяем, действительно ли новый угол меньше старого.
			newAngle := angleDeg(prev, &FullGraphStation{LayoutX: px, LayoutY: py}, next)
			if newAngle >= oldAngle-5 { // требуем хотя бы небольшого улучшения
				continue
			}

			alpha := 0.6
			cur.LayoutX = cur.LayoutX*(1-alpha) + px*alpha
			cur.LayoutY = cur.LayoutY*(1-alpha) + py*alpha
		}
	}
}

// angleDeg вычисляет угол между сегментами prev→cur и cur→next в градусах (0..180).
func angleDeg(prev, cur, next *FullGraphStation) float64 {
	if prev == nil || cur == nil || next == nil {
		return 0
	}
	dx1 := cur.LayoutX - prev.LayoutX
	dy1 := cur.LayoutY - prev.LayoutY
	dx2 := next.LayoutX - cur.LayoutX
	dy2 := next.LayoutY - cur.LayoutY
	len1 := math.Hypot(dx1, dy1)
	len2 := math.Hypot(dx2, dy2)
	if len1 <= 1e-3 || len2 <= 1e-3 {
		return 0
	}
	dot := (dx1*dx2 + dy1*dy2) / (len1 * len2)
	if dot < -1 {
		dot = -1
	} else if dot > 1 {
		dot = 1
	}
	angle := math.Acos(dot) * 180 / math.Pi
	return angle
}

// --- Хабы ---

func snapAllTransferHubs(hubs []FullGraphTransferHub, stationMap map[string]*FullGraphStation) {
	if len(hubs) == 0 {
		return
	}

	ringPriority := []int{5, 95, 97}

	for _, hub := range hubs {
		if len(hub.StationIDs) == 0 {
			continue
		}

		// Собираем станции хаба с валидными layout-координатами
		pts := make([]*FullGraphStation, 0, len(hub.StationIDs))
		for _, sid := range hub.StationIDs {
			st := stationMap[sid]
			if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
				continue
			}
			pts = append(pts, st)
		}
		if len(pts) == 0 {
			continue
		}

		// Барицентр по текущим координатам
		var cx, cy float64
		for _, st := range pts {
			cx += st.LayoutX
			cy += st.LayoutY
		}
		cx /= float64(len(pts))
		cy /= float64(len(pts))

		var anchor *FullGraphStation

		// 1. Ищем станцию на кольце
		for _, ringID := range ringPriority {
			for _, st := range pts {
				if st.LineNumericID == ringID && isFinite(st.LayoutX) && isFinite(st.LayoutY) {
					anchor = st
					break
				}
			}
			if anchor != nil {
				break
			}
		}

		// 2. Любая станция с координатами
		if anchor == nil {
			for _, st := range pts {
				if isFinite(st.LayoutX) && isFinite(st.LayoutY) {
					anchor = st
					break
				}
			}
		}

		// 3. Если всё ещё нет anchor, усредняем lat/lon и проектируем в текущую систему
		if anchor == nil {
			var sumLat, sumLon float64
			var cnt int
			for _, sid := range hub.StationIDs {
				st := stationMap[sid]
				if st != nil && isFinite(st.Lat) && isFinite(st.Lon) {
					sumLat += st.Lat
					sumLon += st.Lon
					cnt++
				}
			}
			if cnt > 0 {
				avgLat := sumLat / float64(cnt)
				avgLon := sumLon / float64(cnt)
				anchor = &FullGraphStation{Lat: avgLat, Lon: avgLon}
				anchor.LayoutX = avgLon
				anchor.LayoutY = avgLat
			}
		}

		// Если есть anchor, слегка смещаем центр в его сторону (для хабов на кольцах)
		if anchor != nil && isFinite(anchor.LayoutX) && isFinite(anchor.LayoutY) {
			blend := 0.5
			cx = cx*(1-blend) + anchor.LayoutX*blend
			cy = cy*(1-blend) + anchor.LayoutY*blend
		}
		if !isFinite(cx) || !isFinite(cy) {
			continue
		}

		validStations := make([]*FullGraphStation, 0, len(hub.StationIDs))
		ringStations := make([]*FullGraphStation, 0, 2)
		otherStations := make([]*FullGraphStation, 0, len(hub.StationIDs))
		for _, sid := range hub.StationIDs {
			st := stationMap[sid]
			if st == nil {
				continue
			}
			validStations = append(validStations, st)
			if _, isRing := ringLineIDs[st.LineNumericID]; isRing {
				ringStations = append(ringStations, st)
			} else {
				otherStations = append(otherStations, st)
			}
		}
		if len(validStations) == 0 {
			continue
		}

		if len(ringStations) > 0 {
			cx = 0
			cy = 0
			for _, st := range ringStations {
				cx += st.LayoutX
				cy += st.LayoutY
			}
			cx /= float64(len(ringStations))
			cy /= float64(len(ringStations))
		}

		if len(otherStations) == 0 {
			continue
		}

		n := len(otherStations)
		dMin := 16.0
		var radius float64
		if n == 1 {
			radius = dMin
		} else if n == 2 {
			radius = dMin / 2
		} else {
			radius = dMin / (2 * math.Sin(math.Pi/float64(n)))
		}

		baseAngle := math.Atan2(cy, cx) + math.Pi/2
		for idx, st := range otherStations {
			angle := baseAngle + 2*math.Pi*float64(idx)/float64(n)
			st.LayoutX = cx + radius*math.Cos(angle)
			st.LayoutY = cy + radius*math.Sin(angle)
		}
	}
}

// --- Раздвижение внутренней части вокруг Кольцевой ---

func explodeInnerStationsAroundRing(lines *[]FullGraphLine, stationMap map[string]*FullGraphStation) {
	if lines == nil {
		return
	}

	// Ищем Кольцевую линию (5)
	var ring *FullGraphLine
	for i := range *lines {
		if (*lines)[i].ID == 5 {
			ring = &(*lines)[i]
			break
		}
	}
	if ring == nil {
		return
	}

	coords := make([]struct{ x, y float64 }, 0, len(ring.StationIDs))
	for _, sid := range ring.StationIDs {
		st := stationMap[sid]
		if st == nil || !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		coords = append(coords, struct{ x, y float64 }{st.LayoutX, st.LayoutY})
	}
	if len(coords) < 3 {
		return
	}

	var cx, cy float64
	for _, p := range coords {
		cx += p.x
		cy += p.y
	}
	cx /= float64(len(coords))
	cy /= float64(len(coords))

	var rSum float64
	for _, p := range coords {
		dx := p.x - cx
		dy := p.y - cy
		rSum += math.Hypot(dx, dy)
	}
	ringRadius := rSum / float64(len(coords))
	if !isFinite(ringRadius) || ringRadius <= 0 {
		return
	}

	innerMax := ringRadius * 0.55
	innerBorder := ringRadius * 0.95
	innerExplosionFactor := 7.0

	for _, st := range stationMap {
		if _, isRing := ringLineIDs[st.LineNumericID]; isRing {
			continue
		}
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}

		dx := st.LayoutX - cx
		dy := st.LayoutY - cy
		r := math.Hypot(dx, dy)
		if !isFinite(r) || r <= 0 {
			continue
		}
		if r >= innerBorder {
			continue
		}

		// t ~ 1 у центра, 0 у границы
		t := 1 - r/innerBorder
		scale := 1 + t*(innerExplosionFactor-1)
		newR := r * scale
		if newR > innerMax {
			newR = innerMax
		}
		k := newR / r
		st.LayoutX = cx + dx*k
		st.LayoutY = cy + dy*k
	}
}

// --- Сглаживание линий ---

func smoothNonRingLines(lines *[]FullGraphLine, stationMap map[string]*FullGraphStation, iterations int) {
	if lines == nil || iterations <= 0 {
		return
	}

	for iter := 0; iter < iterations; iter++ {
		newPos := make(map[string]struct{ x, y float64 })

		for _, line := range *lines {
			if _, isRing := ringLineIDs[line.ID]; isRing {
				continue
			}
			ids := line.StationIDs
			if len(ids) < 3 {
				continue
			}

			for i := 1; i < len(ids)-1; i++ {
				cur := stationMap[ids[i]]
				prev := stationMap[ids[i-1]]
				next := stationMap[ids[i+1]]
				if cur == nil || prev == nil || next == nil {
					continue
				}
				if !isFinite(cur.LayoutX) || !isFinite(cur.LayoutY) || !isFinite(prev.LayoutX) || !isFinite(prev.LayoutY) || !isFinite(next.LayoutX) || !isFinite(next.LayoutY) {
					continue
				}

				tx := (prev.LayoutX + cur.LayoutX + next.LayoutX) / 3
				ty := (prev.LayoutY + cur.LayoutY + next.LayoutY) / 3
				w := 0.8
				sx := cur.LayoutX*(1-w) + tx*w
				sy := cur.LayoutY*(1-w) + ty*w
				newPos[cur.ID] = struct{ x, y float64 }{sx, sy}
			}
		}

		for id, p := range newPos {
			st := stationMap[id]
			if st == nil {
				continue
			}
			st.LayoutX = p.x
			st.LayoutY = p.y
		}
	}
}

// --- Раздвижение станций ---

func optimizeDistances(stationMap map[string]*FullGraphStation, critical, minDist float64, iterations int) {
	if iterations <= 0 {
		return
	}

	// Порядок обхода map в Go случаен от запуска к запуску, а этот проход
	// порядко-зависим: станции сдвигаются по очереди и каждая следующая видит
	// уже сдвинутые. Без сортировки два прогона на одних данных дают разные
	// координаты. Сортировка по ID — единственное, что делает холодный старт
	// воспроизводимым.
	ids := make([]string, 0, len(stationMap))
	for id := range stationMap {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for iter := 0; iter < iterations; iter++ {
		moved := 0
		for i := 0; i < len(ids); i++ {
			st1 := stationMap[ids[i]]
			if st1 == nil || !isFinite(st1.LayoutX) || !isFinite(st1.LayoutY) {
				continue
			}
			// Станции кольцевых линий не двигаем: их координаты должны следовать географической проекции.
			if _, isRing := ringLineIDs[st1.LineNumericID]; isRing {
				continue
			}
			var pushX, pushY float64
			count := 0

			for j := 0; j < len(ids); j++ {
				if i == j {
					continue
				}
				st2 := stationMap[ids[j]]
				if st2 == nil || !isFinite(st2.LayoutX) || !isFinite(st2.LayoutY) {
					continue
				}

				dx := st1.LayoutX - st2.LayoutX
				dy := st1.LayoutY - st2.LayoutY
				d := math.Hypot(dx, dy)
				if d <= 0 || d > minDist {
					continue
				}

				strength := (minDist - d) / minDist
				if d < critical {
					strength *= 2
				}
				nx := dx / d
				ny := dy / d
				pushX += nx * strength * 10
				pushY += ny * strength * 10
				count++
			}

			if count > 0 {
				st1.LayoutX += pushX / float64(count)
				st1.LayoutY += pushY / float64(count)
				moved++
			}
		}
		if iter > 3 && moved < 3 {
			break
		}
	}
}

// --- Масштабирование ---

func scaleEntireMap(stationMap map[string]*FullGraphStation) {
	minX := math.Inf(1)
	maxX := math.Inf(-1)
	minY := math.Inf(1)
	maxY := math.Inf(-1)

	for _, st := range stationMap {
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		if st.LayoutX < minX {
			minX = st.LayoutX
		}
		if st.LayoutX > maxX {
			maxX = st.LayoutX
		}
		if st.LayoutY < minY {
			minY = st.LayoutY
		}
		if st.LayoutY > maxY {
			maxY = st.LayoutY
		}
	}

	if !isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY) {
		return
	}

	width := maxX - minX
	height := maxY - minY
	if width <= 0 || height <= 0 {
		return
	}

	const targetWidth = 2200.0
	const targetHeight = 1700.0
	const padding = 150.0

	// Масштабирование отключаем: работаем в координатах, полученных из проекции lat/lon.
	// Оставляем только центрирование схемы в целевом окне.
	_ = padding
	scale := 1.0

	cx := (minX + maxX) / 2
	cy := (minY + maxY) / 2
	targetCX := targetWidth / 2
	targetCY := targetHeight / 2

	for _, st := range stationMap {
		if !isFinite(st.LayoutX) || !isFinite(st.LayoutY) {
			continue
		}
		st.LayoutX = targetCX + (st.LayoutX-cx)*scale
		st.LayoutY = targetCY + (st.LayoutY-cy)*scale
	}
}
