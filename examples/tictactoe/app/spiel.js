// Tic-Tac-Toe – bewusst klein: Spiellogik als reine Funktionen, Oberfläche mit zugänglichen Rollen und Namen.
export const LINIEN = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function auswerten(felder) {
  for (const l of LINIEN) {
    const [a, b, c] = l;
    if (felder[a] && felder[a] === felder[b] && felder[a] === felder[c]) return { sieger: felder[a], linie: l };
  }
  return felder.every(Boolean) ? { unentschieden: true } : null;
}

if (typeof document !== 'undefined') {
  const brett = document.querySelector('.brett');
  const status = document.getElementById('status');
  let felder, amZug, ende;
  const zeilenName = ['oben', 'Mitte', 'unten'];
  const spaltenName = ['links', 'Mitte', 'rechts'];
  const name = (i) => `Feld ${zeilenName[Math.floor(i / 3)]} ${spaltenName[i % 3]}`.replace('Mitte Mitte', 'Mitte');

  function zeichnen() {
    brett.replaceChildren(...felder.map((f, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f ?? '';
      b.setAttribute('aria-label', `${name(i)}${f ? `: ${f}` : ''}`);
      b.disabled = !!f || !!ende;
      if (ende?.linie?.includes(i)) b.classList.add('gewinn');
      b.addEventListener('click', () => setzen(i));
      return b;
    }));
    status.textContent = ende?.sieger ? `${ende.sieger} gewinnt!` : ende?.unentschieden ? 'Unentschieden' : `${amZug} ist am Zug`;
  }
  function setzen(i) {
    if (felder[i] || ende) return;
    felder[i] = amZug;
    ende = auswerten(felder);
    amZug = amZug === 'X' ? 'O' : 'X';
    zeichnen();
  }
  function neu() {
    felder = Array(9).fill(null);
    amZug = 'X';
    ende = null;
    zeichnen();
  }
  document.getElementById('neu').addEventListener('click', neu);
  neu();
}
