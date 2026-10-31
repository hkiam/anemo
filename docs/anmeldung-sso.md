# Unternehmensanmeldung: Keycloak, Entra ID, LDAP/Active Directory

Anemo unterstützt neben lokalen Konten **OpenID Connect** (Keycloak, Microsoft Entra ID, ADFS, Authentik …) und
**LDAP/Active Directory** (Anmeldung mit dem Domänenpasswort). Beim ersten Anmelden wird das Konto angelegt.
Gruppen bzw. Rollen aus dem Verzeichnis werden als Anemo-Gruppen übernommen und bei jeder Anmeldung abgeglichen.
Projektrollen vergibt man anschließend **an diese Gruppen** (Administration → Projekte & Rechte → Mitglieder).
Lokale Konten werden nie automatisch übernommen. Gibt es einen Namenskonflikt, meldet Anemo das, statt Konten
zusammenzuführen. Der lokale `admin` bleibt als Notzugang erhalten.

Alle Einstellungen sind Umgebungsvariablen (Container bzw. `.env`). `ANEMO_PUBLIC_URL` muss die Adresse sein,
unter der Anemo im Browser erreichbar ist. Daraus ergibt sich die Rücksprungadresse
`<ANEMO_PUBLIC_URL>/api/auth/oidc/callback`.

## Keycloak
1. Im Realm einen Client anlegen: *Client authentication* an (vertraulich), *Standard flow* an,
   *Valid redirect URIs* `https://anemo.firma.de/api/auth/oidc/callback`,
   *Valid post logout redirect URIs* `https://anemo.firma.de/*`.
2. Gruppen ins Token: *Client scopes → <client>-dedicated → Add mapper → Group Membership*, Token Claim Name
   `groups`, „Full group path“ nach Wunsch. Alternativ Rollen über `realm_access.roles` oder
   `resource_access.<client>.roles`.
3. Anemo:
```env
ANEMO_PUBLIC_URL=https://anemo.firma.de
OIDC_ISSUER=https://keycloak.firma.de/realms/firma
OIDC_CLIENT_ID=anemo
OIDC_CLIENT_SECRET=<Client-Secret>
OIDC_GROUPS_CLAIM=groups                 # oder: groups,realm_access.roles,resource_access.anemo.roles
OIDC_GROUPS_FULL_PATH=false              # true: "/IT/QA" statt "QA"
OIDC_ADMIN_GROUP=anemo-admins            # Mitglieder werden Systemadministratoren (optional)
OIDC_LABEL=Mit Firmenkonto anmelden
```

## Microsoft Entra ID (Azure AD)
1. *App-Registrierung* anlegen, Plattform „Web“, Umleitungs-URI `https://anemo.firma.de/api/auth/oidc/callback`,
   Abmelde-URL `https://anemo.firma.de/`. Unter *Zertifikate & Geheimnisse* einen geheimen Clientschlüssel
   erzeugen.
2. **Empfohlen: App-Rollen** (z. B. `Anemo.Tester`, `Anemo.Designer`, `Anemo.Admin`) anlegen und Personen oder
   Gruppen in der *Unternehmensanwendung* zuweisen. Sie stehen im Claim `roles`, mit lesbaren Namen und ohne die
   Grenze von 200 Gruppen pro Token („groups overage“).
   Alternativ den Gruppenanspruch aktivieren (*Tokenkonfiguration → Gruppenanspruch*). Gruppen kommen dann als
   **Objekt-IDs** an. Anemo legt sie mit der ID als Namen an, der Anzeigename lässt sich in Anemo ändern, die
   Zuordnung bleibt.
3. Anemo:
```env
ANEMO_PUBLIC_URL=https://anemo.firma.de
OIDC_ISSUER=https://login.microsoftonline.com/<Mandanten-ID>/v2.0
OIDC_CLIENT_ID=<Anwendungs-ID>
OIDC_CLIENT_SECRET=<Clientschlüssel>
OIDC_SCOPES=openid profile email
OIDC_GROUPS_CLAIM=roles                  # oder: groups (Objekt-IDs)
OIDC_TOKEN_AUTH=post                     # Entra: client_secret_post (Basic geht ebenfalls)
OIDC_ADMIN_GROUP=Anemo.Admin
OIDC_USERNAME_STRIP_DOMAIN=true          # "k.weber@firma.de" → "k.weber" (Standard)
```
Als Kennung dient die Objekt-ID (`oid`). Namensänderungen in Entra lösen also kein neues Konto aus.

## LDAP / Active Directory
```env
LDAP_URL=ldaps://dc1.firma.local:636      # ldap:// nur in geschütztem Netz
LDAP_BASE_DN=DC=firma,DC=local
LDAP_BIND_DN=CN=svc-anemo,OU=Dienste,DC=firma,DC=local
LDAP_BIND_PASSWORD=<Passwort Dienstkonto>
LDAP_USER_FILTER=(&(objectClass=user)(sAMAccountName={username}))   # OpenLDAP: (uid={username})
LDAP_GROUP_PATTERN=^(QA|Anemo)-          # nur passende Gruppen übernehmen (AD hat oft Hunderte)
LDAP_ADMIN_GROUP=Anemo-Admins
# OpenLDAP mit groupOfNames statt memberOf:
# LDAP_GROUP_FILTER=(&(objectClass=groupOfNames)(member={dn}))
# LDAP_GROUP_BASE_DN=ou=groups,dc=firma,dc=local
```
Mit LDAP melden sich alle Personen ohne lokales Konto im normalen Anmeldefenster mit ihrem Domänenpasswort an.
Ist der Verzeichnisdienst nicht erreichbar, erscheint eine Meldung, lokale Konten funktionieren weiter.

## Abmelden
Bei OIDC-Konten meldet „Abmelden“ auch beim Anbieter ab (Keycloak/Entra `end_session_endpoint`). Abschalten mit
`OIDC_LOGOUT=false`.
