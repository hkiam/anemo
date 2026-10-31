import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null; info: string | null }

/**
 * Fehlergrenze: Ein Darstellungsfehler zeigt eine Meldung mit Details statt einer leeren Seite und wird ans Server-Log
 * gemeldet (POST /api/client-errors). `resetKey` (z. B. die Adresse) setzt die Grenze beim Seitenwechsel zurück.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; area?: string }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
    void fetch('/api/client-errors', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ message: `${this.props.area ? `${this.props.area}: ` : ''}${error.message}`.slice(0, 2000), stack: error.stack?.slice(0, 8000),
        component: info.componentStack?.slice(0, 4000), url: window.location.hash.slice(0, 500) }),
    }).catch(() => undefined);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, info: null });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page"><div className="page-narrow stack" role="alert">
        <h2>Hier ist etwas schiefgegangen</h2>
        <p>Die Ansicht konnte nicht dargestellt werden. Der Fehler wurde ans Server-Log gemeldet. Eingaben in anderen Fenstern sind nicht betroffen.</p>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null, info: null })}>Erneut versuchen</button>
          <button onClick={() => window.location.reload()}>Seite neu laden</button>
          <a className="btn" href="#/">Zur Startseite</a>
        </div>
        <details><summary>Technische Details</summary>
          <pre className="code small" style={{ whiteSpace: 'pre-wrap' }}>{error.message}{'\n\n'}{error.stack ?? ''}{info ? `\n\nKomponenten:${info}` : ''}</pre>
        </details>
      </div></div>
    );
  }
}
