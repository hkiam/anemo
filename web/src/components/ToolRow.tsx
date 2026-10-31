import type { ReactNode } from 'react';

/**
 * Werkzeugleiste unter einem Ergebnis (Schritt bzw. Ausführung): einheitliche Knöpfe mit Symbol und Text – Anhang,
 * Fehler melden, Fehler verknüpfen … und künftig weitere Aktionen. Gleiche Höhe, gleicher Stil, eine Zeile.
 */
export function ToolRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tool-row" role="toolbar" aria-label={label}>{children}</div>;
}

/** Knopf der Werkzeugleiste; `attention` hebt ihn hervor (z. B. Fehler melden bei fehlgeschlagenem Schritt). */
export function ToolButton({ icon, children, onClick, title, attention, disabled, ariaLabel }: {
  icon: string; children: ReactNode; onClick: () => void; title?: string; attention?: boolean; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <button type="button" className={`tool-btn${attention ? ' attention' : ''}`} onClick={(e) => { e.stopPropagation(); onClick(); }} title={title} disabled={disabled} aria-label={ariaLabel}>
      <span className="icon tool-icon" aria-hidden="true">{icon}</span><span className="tool-text">{children}</span>
    </button>
  );
}

/** Datei-Knopf im gleichen Stil (öffnet die Dateiauswahl). */
export function ToolFileButton({ icon = '📎', children, onFiles, title, ariaLabel }: { icon?: string; children: ReactNode; onFiles: (files: File[]) => void; title?: string; ariaLabel?: string }) {
  return (
    <label className="tool-btn" title={title} aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
      <span className="icon tool-icon" aria-hidden="true">{icon}</span><span className="tool-text">{children}</span>
      <input type="file" multiple className="sr-only" onChange={(ev) => { const fs = [...(ev.target.files ?? [])]; ev.target.value = ''; if (fs.length) onFiles(fs); }} />
    </label>
  );
}
