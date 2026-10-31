/**
 * Abgleich von Verweis-Snapshots mit dem Fremdsystem (Jira, OpenProject). Wechselt ein verknüpfter Fehler an
 * einer Ausführung von offen nach erledigt, entsteht automatisch eine Nachtest-Ausführung (B2).
 */
import type { Db } from '../../platform/db.ts';
import { createRetest } from '../execution/index.ts';
import { defectResolution } from '../references/index.ts';

export interface RefUpdate { key: string; title: string | null; status: string | null; url: string | null }

/**
 * Titel/Status übernehmen. `refIds`: nur diese Verweise (die zum zugeordneten Fremdprojekt passen) – derselbe Schlüssel
 * kann in einem anderen Anemo-Projekt ohne Projektbezug verknüpft sein und bekommt dann keinen Titel (Sicherheit 3).
 */
export async function applyReferenceUpdates(db: Db, provider: string, updates: RefUpdate[], refIds: string[] | null = null): Promise<{ updated: number; retests: number }> {
  let updated = 0;
  let retests = 0;
  for (const u of updates) {
    const refs = await db<{ id: string; ownerType: string; ownerId: string; relation: string; title: string | null; status: string | null; url: string | null }[]>`
      select id, owner_type, owner_id, relation, title, status, url from external_reference where provider = ${provider} and external_key = ${u.key}
        and (${refIds === null} or id = any(${refIds ?? []}::uuid[]))`;
    for (const r of refs) {
      if (r.title === u.title && r.status === u.status && r.url) continue;
      await db`update external_reference set title = ${u.title}, status = ${u.status}, url = coalesce(url, ${u.url}) where id = ${r.id}`;
      updated++;
      // Nachtest nur bei behobenen Fehlern – abgelehnte bleiben bekannte Fehler (Restrisiko), ohne Nachtest
      const nowResolved = defectResolution(u.status) === 'fixed' && defectResolution(r.status) !== 'fixed';
      if (nowResolved && r.relation === 'DEFECT' && r.ownerType === 'TEST_EXECUTION') {
        if (await createRetest(db, r.ownerId, { provider, key: u.key, title: u.title, status: u.status }, `${provider}-abgleich`)) retests++;
      }
    }
  }
  return { updated, retests };
}
