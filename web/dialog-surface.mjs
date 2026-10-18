export function createDialogSurface(win) {
  const doc = win.document;
  const dialogs = [...doc.querySelectorAll('dialog')];
  let host = doc;
  function mount() {
    try {
      if (new URLSearchParams(win.location.search).get('embed') !== '1' || win.parent === win) return;
      const parent = win.parent.document;
      if (parent.getElementById('office-frame')?.contentWindow !== win) return;
      for (const dialog of dialogs) parent.body.append(dialog);
      host = parent;
    } catch {   }
  }
  function restore() {
    for (const dialog of dialogs) {
      if (dialog.open) dialog.close();
      doc.body.append(dialog);
    }
    host = doc;
  }
  mount();
  win.addEventListener('pagehide', restore);
  win.addEventListener('pageshow', mount);
  return {
    dialogs,
    getElementById(id) { return doc.getElementById(id) ?? host.getElementById(id); },
  };
}
