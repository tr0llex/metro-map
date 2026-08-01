// Сборка схемы: каталог data/ -> normalized/fullGraph.json.
//
// Проход ровно один и он геометрический: подогнать форму кольцевых линий,
// спроецировать на неё станции и развести станции, налезающие друг на друга.
// Всё остальное — станции, связи, времена, координаты — приходит из data/ как
// есть. Автоматической раскладки «с нуля» здесь больше нет: координаты станций
// расставлены руками и лежат в data/layout.json, а любой алгоритмический проход
// поверх них гарантированно затирался.
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
	dataDir := flag.String("data", "data", "каталог с данными схемы (lines/, transfers.json, layout.json)")
	outPath := flag.String("out", "normalized/fullGraph.json", "куда писать собранный граф")
	flag.Parse()

	graph, err := BuildFullGraph(*dataDir)
	if err != nil {
		log.Fatalf("сборка графа: %v", err)
	}

	fmt.Printf("данные: линий %d, станций %d, рёбер %d, узлов пересадки %d\n",
		len(graph.Lines), len(graph.Stations), len(graph.Edges), len(graph.TransferHubs))

	ringStats := ApplyRingProjection(&graph, ringShapeOverrides(graph.RingShapes))
	for _, s := range ringStats {
		fmt.Printf("кольцо, линия %d: %s по %d станциям, rms=%.2f mean=%.2f max=%.2f\n",
			s.LineID, s.Kind, s.Stations, s.RMS, s.MeanDev, s.MaxDev)
	}

	if err := writeGraphJSON(graph, *outPath); err != nil {
		log.Fatalf("запись графа: %v", err)
	}

	fmt.Printf("граф записан в %s\n", *outPath)
}

func writeGraphJSON(graph FullGraphExport, outPath string) error {
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("создание каталога: %w", err)
	}

	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("создание файла: %w", err)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(graph); err != nil {
		return fmt.Errorf("кодирование json: %w", err)
	}

	return nil
}
