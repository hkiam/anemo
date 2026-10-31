/** Erledigungsstand eines Tickets aus seinem Status (Jira, OpenProject, freie Links) – Server und Oberfläche nutzen dieselbe Regel. */
export type DefectResolution = 'open' | 'fixed' | 'rejected';

export function defectResolution(s: string | null | undefined): DefectResolution {
  const v = s ?? '';
  if (/abgelehnt|rejected|won'?t fix|wird nicht behoben|nicht behoben|kein fehler|not a bug|invalid|ungültig|duplikat|duplicate|zurückgestellt|deferred/i.test(v)) return 'rejected';
  if (/erledigt|fertig|geschlossen|abgeschlossen|gelöst|behoben|closed|done|resolved|fixed/i.test(v)) return 'fixed';
  return 'open';
}

/** Gilt ein Ticket als nicht mehr offen (behoben oder abgelehnt)? */
export const isResolvedStatus = (s: string | null | undefined) => defectResolution(s) !== 'open';
