/// <reference types="vite/client" />

// SVG assets are imported as URLs (string). Add React component typing if needed later.
declare module '*.svg' {
  const src: string
  export default src
}
