import logoUrl from '../assets/anemo-logo.svg';

/** Anemo-Logo (Bildmarke); dekorativ, der Name steht daneben als Text. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <img className="brand-mark" src={logoUrl} width={size} height={size} alt="" aria-hidden="true" />;
}
