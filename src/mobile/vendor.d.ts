declare module 'pdfmake/build/pdfmake' {
  interface OutputDocument {
    getBuffer(): Promise<Uint8Array>
    getBlob(): Promise<Blob>
  }
  const pdfMake: {
    addVirtualFileSystem(vfs: Record<string, string>): void
    createPdf(dd: unknown): OutputDocument
  }
  export default pdfMake
}
declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string>
  export default vfs
}
declare module 'html-to-pdfmake' {
  export default function htmlToPdfmake(html: string, opts?: Record<string, unknown>): unknown
}
