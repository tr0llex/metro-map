// Ручная раскладка из редактора — единственный путь, который реально
// определяет геометрию на текущих данных.
//
// Автоматическая раскладка «с нуля» вынесена в layout_bootstrap.go: она
// работает только тогда, когда ручной раскладки нет. Всё, что накладывается
// здесь, перезаписывает результат солвера целиком.
package main

// --- Layout overrides from editor / JSON ---

// LayoutOverride описывает ручной оверрайд координат станции по её ID.
// Используется для применения правок из редактора MetroMap к оффлайн-лейауту.
type LayoutOverride struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// ApplyLayoutOverrides поверх уже рассчитанного layout'а применяет ручные
// оверрайды координат: для каждой станции с указанным ID подставляет
// LayoutX/LayoutY из overrides.
func ApplyLayoutOverrides(graph *FullGraphExport, overrides map[string]LayoutOverride) {
	if graph == nil {
		return
	}
	if len(overrides) == 0 {
		return
	}

	for i := range graph.Stations {
		st := &graph.Stations[i]
		ov, ok := overrides[st.ID]
		if !ok {
			continue
		}
		if !isFinite(ov.X) || !isFinite(ov.Y) {
			continue
		}
		st.LayoutX = ov.X
		st.LayoutY = ov.Y
	}
}
