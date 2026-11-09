// Images imported from the renderer code (Vite turns them into URLs).
declare module '*.png' {
  const src: string
  export default src
}
