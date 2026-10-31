import { api } from '../api.ts';
import { askText } from '../ux.tsx';

/**
 * Ergebnis einer Ausführung speichern. Passt ein abschließender Gesamtstatus nicht zu den Schritt- bzw.
 * Durchlaufergebnissen, lehnt der Server mit 400 ab („… bitte begründen“). Dann wird nach einer Begründung gefragt
 * und mit `overrideReason` erneut gesendet. Liefert false, wenn die Begründung abgebrochen wurde.
 */
export async function postResult(executionId: string, body: Record<string, unknown>, label = 'Ausführung'): Promise<boolean> {
  try {
    await api('POST', `/api/executions/${executionId}/result`, body);
    return true;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status !== 400 || !/begründen|passt nicht/i.test(err.message)) throw e;
    const reason = await askText({
      title: `${label}: abweichendes Gesamtergebnis begründen`, label: 'Begründung (wird im Ergebnisverlauf gespeichert)', multiline: true,
      hint: err.message, confirmLabel: 'Mit Begründung speichern',
    });
    if (reason === null || !reason.trim()) return false;
    await api('POST', `/api/executions/${executionId}/result`, { ...body, overrideReason: reason.trim() });
    return true;
  }
}
