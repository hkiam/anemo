/**
 * Dauerhafte Links nach außen (OpenProject, Mails, Chat): kurze Adressen unter /go/…, die der Server auf die jeweilige
 * Ansicht weiterleitet. Sie hängen nicht an der inneren Struktur der Oberfläche und bleiben bei deren Umbau gültig;
 * zieht Anemo um, genügt eine neue öffentliche Adresse (bzw. ein DNS-Alias) – siehe „Rückverweise aktualisieren“.
 *
 * Basis nur aus ANEMO_PUBLIC_URL, nie aus dem Host-Kopf der Anfrage (sonst ließen sich Links umleiten). Ohne Basis: null.
 */
import { settingsEnv } from './settings.ts';

export const publicBase = (): string => settingsEnv().ANEMO_PUBLIC_URL?.trim().replace(/\/+$/, '') ?? '';

export type GoKind = 'ausfuehrung' | 'testfall' | 'zyklus' | 'plan' | 'sitzung' | 'ticket';
export const GO_KINDS: readonly GoKind[] = ['ausfuehrung', 'testfall', 'zyklus', 'plan', 'sitzung', 'ticket'];

/** Pfad eines dauerhaften Links, z. B. /go/testfall/DEMO-T29 oder /go/ticket/openproject/PROJ-315 */
export function goPath(kind: GoKind, ...ids: string[]): string {
  return `/go/${kind}/${ids.map((x) => encodeURIComponent(x)).join('/')}`;
}

/** Vollständiger dauerhafter Link (mit öffentlicher Adresse) oder null, wenn keine Adresse eingestellt ist. */
export function goLink(kind: GoKind, ...ids: string[]): string | null {
  const base = publicBase();
  return base ? `${base}${goPath(kind, ...ids)}` : null;
}
