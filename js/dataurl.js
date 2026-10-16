// URL helpers shared by the views. Everything is relative to the page, so the
// site works from a repo subpath; window.BUILDER_DATA_BASE swaps the data folder
// (the smoke tests point it at the fixture dataset).

// The data folder, always with a trailing slash.
export function dataBase() {
  let base = typeof window.BUILDER_DATA_BASE === 'string' && window.BUILDER_DATA_BASE ? window.BUILDER_DATA_BASE : 'data/';
  if (!base.endsWith('/')) base += '/';
  return base;
}

// "data/img/m3q2n1.jpg" -> "<data base>img/m3q2n1.jpg"
export function figureUrl(figure) {
  return dataBase() + String(figure).replace(/^data\//, '');
}

// The notes fragment for a document id that has ALREADY been checked against
// the notes index (never build this from raw user input).
export function notesFragmentUrl(docId) {
  return `${dataBase()}notes/${encodeURIComponent(docId)}.html`;
}

// Link to a notes document, optionally to one heading. Segments are URI-encoded.
export function notesHref(noteDoc, anchor) {
  const doc = encodeURIComponent(noteDoc);
  return anchor ? `#/browse/notes/${doc}/${encodeURIComponent(anchor)}` : `#/browse/notes/${doc}`;
}
