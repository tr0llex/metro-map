package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

func main() {
	csvPath := flag.String("csv", "new_map_source/metro.ru.csv", "path to metro.ru.csv")
	connPath := flag.String("connections", "new_map_source/connections.json", "path to connections.json")
	outPath := flag.String("out", "normalized/fullGraph.json", "path to output fullGraph.json")
	yandexPath := flag.String("yandex", "", "optional path to yandex_coords.json from Yandex Metro SVG")
	editorOverridesPath := flag.String("editor_overrides", "", "optional path to editor_overrides.json with all manual overrides from editor")
	travelTimesPath := flag.String("travel_times", "new_map_source/travel_times.json", "path to travel_times.json with ride/transfer times; empty or missing file falls back to distance-based estimate")
	strictOverrides := flag.Bool("strict_overrides", false, "fail the build on unknown top-level keys in editor_overrides.json instead of reporting them to stderr")

	flag.Parse()

	// Времена перегонов и пересадок задаются конфигом, а не геометрией.
	// Отсутствие файла — не ошибка: солвер тогда работает как раньше, но об
	// этом надо сказать вслух, иначе подмена модели времени пройдёт незаметно.
	var times *TravelTimes
	if *travelTimesPath != "" {
		t, err := loadTravelTimes(*travelTimesPath)
		switch {
		case err == nil:
			times = t
		case os.IsNotExist(err):
			fmt.Printf("travel times: файл %s не найден — время считается по расстоянию (запасной путь)\n", *travelTimesPath)
		default:
			log.Fatalf("read travel times: %v", err)
		}
	}

	graph, err := BuildFullGraph(*csvPath, *connPath, *yandexPath, times)
	if err != nil {
		log.Fatalf("build full graph: %v", err)
	}
	if times != nil {
		times.Report(os.Stdout)
	}

	var editorOv *GraphOverrides
	if *editorOverridesPath != "" {
		ov, err := readGraphOverrides(*editorOverridesPath, *strictOverrides)
		if err != nil {
			log.Fatalf("read editor overrides: %v", err)
		}
		editorOv = ov
		if err := ApplyGraphOverrides(&graph, ov); err != nil {
			log.Fatalf("apply editor overrides (pre-layout): %v", err)
		}
	}

	// Ручная раскладка из редактора и автоматическая — взаимоисключающие пути,
	// а не два прохода подряд. Оверрайды задают координаты всем станциям сразу
	// и перезаписывают результат солвера целиком, поэтому запускать солвер под
	// ними бессмысленно: он гарантированно затирается (см. layout_bootstrap.go).
	if editorOv != nil && len(editorOv.Layout) > 0 {
		ApplyLayoutOverrides(&graph, editorOv.Layout)
	} else {
		// Холодный старт: ручной раскладки нет — раскладываем схему алгоритмом.
		if err := ApplyLayout(&graph); err != nil {
			log.Fatalf("apply layout: %v", err)
		}
	}

	// Финальный проход: подгонка формы колец, проекция станций на форму и
	// публикация форм в ringShapes. Обязан идти ПОСЛЕ ApplyLayoutOverrides —
	// ручные оверрайды из редактора полностью перезаписывают layoutX/layoutY.
	//
	// Ручные формы колец подключаются здесь же, а не отдельным проходом до
	// ApplyLayoutOverrides: любой проход, который расставляет координаты раньше
	// него, гарантированно затирается — в editor_overrides.json координаты есть
	// у всех станций схемы.
	ringStats := ApplyRingProjection(&graph, ringShapeOverrides(editorOv))
	for _, s := range ringStats {
		fmt.Printf("ring line %d: %s over %d stations, rms=%.2f mean=%.2f max=%.2f\n",
			s.LineID, s.Kind, s.Stations, s.RMS, s.MeanDev, s.MaxDev)
	}

	if err := writeGraphJSON(graph, *outPath); err != nil {
		log.Fatalf("write graph: %v", err)
	}

	fmt.Printf("full graph written to %s\n", *outPath)
}

func writeGraphJSON(graph FullGraphExport, outPath string) error {
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}

	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create output file: %w", err)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(graph); err != nil {
		return fmt.Errorf("encode json: %w", err)
	}

	return nil
}
