# ADR-0021: Unternehmensanmeldung über OIDC und LDAP ohne Zusatzbibliotheken

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Anmeldung und Gruppen sollen aus dem Unternehmensverzeichnis kommen. Vorgesehen sind Keycloak und Microsoft
Entra ID (OIDC) sowie Active Directory/OpenLDAP. Der Container soll schlank bleiben, und Rollen je Projekt
(ADR-0011) sollen weiter gelten.

## Entscheidung
- **OIDC** mit Authorization Code und PKCE (S256), Nonce, `state` in der Datenbank (10 Minuten, einmalig).
  Das ID-Token wird selbst geprüft: Signatur über JWKS (RS/PS/ES, Schlüsselwechsel durch Nachladen), Issuer,
  Audience, Ablauf, Nonce. Gruppen kommen aus einem oder mehreren Claims mit Punkt-Pfaden (Keycloak
  `realm_access.roles`, Entra `roles`), Keycloak-Gruppenpfade werden gekürzt. Externe Kennung ist `oid` (Entra)
  bzw. `sub`. Abmelden beim Anbieter über `end_session_endpoint`.
- **LDAP**: eigener LDAPv3-Client (BER, Simple Bind, Search, LDAPS), Benutzersuche mit Dienstkonto und
  maskiertem Filter, Anmeldung per Bind als Benutzer. Gruppen über `memberOf` oder einen Gruppenfilter,
  eingrenzbar per Muster.
- **Bereitstellung**: Konto beim ersten Login anlegen (Quelle `ldap`/`oidc`, externe Kennung). Gruppen der
  gleichen Quelle bei jedem Login abgleichen, lokale Gruppen bleiben unberührt. Optional verleiht eine
  Admin-Gruppe Systemadministration. Lokale Konten werden nie automatisch verknüpft (Konfliktmeldung). Projektrollen
  vergibt Anemo an Gruppen, die Rechteprüfung bleibt unverändert.

## Konsequenzen
Kein SCIM: Austritte wirken bei der nächsten Anmeldung, laufende Sitzungen enden nach höchstens 12 h Leerlauf.
Entra „groups overage“ wird erkannt und protokolliert; dafür werden App-Rollen empfohlen.
