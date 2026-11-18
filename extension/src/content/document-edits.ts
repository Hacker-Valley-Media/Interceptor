// The isolated-world document wrapper is shared by the extension's bundles in this frame.
declare global {
  interface Document { __interceptorEdited?: boolean }
}

export function markDocumentEdited(): void {
  document.__interceptorEdited = true
}
