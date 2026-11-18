import "./content/net-buffer"
import { markDocumentEdited } from "./content/document-edits"

if (document.__interceptorEdited === undefined) {
  document.__interceptorEdited = false
  const onEdit = (event: Event) => { if (event.isTrusted) markDocumentEdited() }
  document.addEventListener("input", onEdit, true)
  document.addEventListener("change", onEdit, true)
}
