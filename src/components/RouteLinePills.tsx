// Компактная полоска цветов линий маршрута.
//
// Нужна, чтобы вариант маршрута можно было выбрать «на глаз»: в метро люди
// опознают маршрут по цветам веток, а не по числу пересадок.

interface RouteLinePillsProps {
  /** Цвета линий в порядке следования по маршруту (уже без повторов подряд). */
  colors: string[]
  className?: string
}

export function RouteLinePills({ colors, className }: RouteLinePillsProps) {
  if (colors.length === 0) return null

  return (
    <span className={`route-line-pills${className ? ` ${className}` : ''}`} aria-hidden="true">
      {colors.map((color, index) => (
        <span
          key={`${color}-${index}`}
          className="route-line-pills-item"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}
