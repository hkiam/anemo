// Verweise auf das Repository aus der Adresse der Website ableiten (<konto>.github.io/<repository>/ → github.com/<konto>/<repository>),
// damit die Seite ohne feste Adresse auskommt. Lokal bzw. unter eigener Domain bleibt der Platzhalter stehen.
(() => {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return;
  const name = location.pathname.split('/').filter(Boolean)[0];
  const repo = name && !/\.html$/.test(name) ? `https://github.com/${m[1]}/${name}` : `https://github.com/${m[1]}/${m[1]}.github.io`;
  document.querySelectorAll('[data-repo]').forEach((a) => { a.href = repo; });
  document.querySelectorAll('[data-repo-path]').forEach((a) => { a.href = `${repo}/blob/main/${a.dataset.repoPath}`; });
  document.querySelectorAll('[data-repo-text]').forEach((s) => { s.textContent = repo; });
})();
