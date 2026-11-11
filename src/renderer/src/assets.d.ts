// Images imported from the renderer code (Vite turns them into URLs).
declare module '*.png' {
  const src: string
  export default src
}

// Files imported as text (Vite "?raw"), e.g. the spell-check dictionaries.
declare module '*?raw' {
  const text: string
  export default text
}
