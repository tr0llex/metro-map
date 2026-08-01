// Инлайновые SVG-иконки.
//
// Специально без внешних файлов и без сторонних библиотек: всё едет внутри JS-бандла,
// поэтому иконки одинаково выглядят на iOS/Android, работают офлайн и не требуют
// послаблений в CSP (нет ни внешних запросов, ни data:-URL картинок).
//
// Все иконки наследуют цвет через `currentColor` и масштабируются от `font-size`
// родителя (ширина/высота заданы в `em`), поэтому их можно ставить в любой чип
// или кнопку без дополнительных стилей.

import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** Размер иконки. По умолчанию — 1em, т.е. кегль текста родителя. */
  size?: number | string
}

function baseProps({ size = '1em', ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    focusable: false,
    'aria-hidden': true,
    ...rest,
  } as const
}

/** Двойная стрелка вверх/вниз — «поменять станции местами». */
export function IconSwap(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4v16" />
      <path d="M4.5 7.5 8 4l3.5 3.5" />
      <path d="M16 20V4" />
      <path d="M12.5 16.5 16 20l3.5-3.5" />
    </svg>
  )
}

/** Звезда — «избранное». Заливается currentColor, когда filled. */
export function IconStar({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg
      {...baseProps(props)}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    >
      <path d="M12 3.6l2.6 5.28 5.83.85-4.22 4.11.996 5.8L12 16.9l-5.21 2.74.996-5.8-4.22-4.11 5.83-.85z" />
    </svg>
  )
}

/** Крестик — «закрыть» / «очистить». */
export function IconClose(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

/** Метка на карте — «рядом». */
export function IconPin(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round">
      <path d="M12 21s6.5-6.1 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  )
}

/** Круговая стрелка — «недавние». */
export function IconHistory(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 11.2a7.8 7.8 0 1 1 2.1 6" />
      <path d="M3.4 19.4l.7-4.3 4.3.7" />
      <path d="M12 7.8V12l2.8 1.7" />
    </svg>
  )
}

/** Часы — «время в пути». */
export function IconClock(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.1 1.9" />
    </svg>
  )
}

/** Стрелка из коробки — «поделиться». */
export function IconShare(props: IconProps) {
  return (
    <svg {...baseProps(props)} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5v11" />
      <path d="M8.4 7.1 12 3.5l3.6 3.6" />
      <path d="M5.5 12.6v6.2a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7v-6.2" />
    </svg>
  )
}
