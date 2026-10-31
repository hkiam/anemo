# Ein schlanker Container: distroless Node (ohne Shell/Paketmanager), non-root.
# Das Backend läuft ohne Build-Schritt (Node Type-Stripping); nur die Web-UI wird gebaut.

FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund
# Fremdkomponenten prüfen (Lizenzen, bekannte Schwachstellen) und SBOM erzeugen – ein Verstoß bricht den Build ab.
# Ohne Netz (Offline-Build): --build-arg THIRD_PARTY_AUDIT=--audit-optional
ARG ANEMO_VERSION=""
ARG THIRD_PARTY_AUDIT=""
COPY Dockerfile LICENSE NOTICE ./
COPY config/third-party.json config/
COPY tools/package.json tools/third-party.ts tools/
# mitgelieferte Schriften und Farbprofil der PDF-Berichte: Prüfsummen und Lizenztexte
COPY server/assets server/assets
RUN ANEMO_VERSION="$ANEMO_VERSION" node tools/third-party.ts all $THIRD_PARTY_AUDIT
COPY shared shared
COPY web web
RUN npm run build -w web

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @anemo/server --no-audit --no-fund

FROM gcr.io/distroless/nodejs22-debian12:nonroot
LABEL org.opencontainers.image.title="Anemo" org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Agentische Plattform für Testmanagement und Qualitätssicherung"
WORKDIR /app
# Version: Nummer aus package.json, Commit und Build-Zeitpunkt aus dem Build (sichtbar in Kontomenü und Administration)
ARG ANEMO_COMMIT=""
ARG ANEMO_BUILT_AT=""
ENV NODE_ENV=production WEB_DIST=/app/web/dist ANEMO_PORT=8080 ANEMO_COMMIT=$ANEMO_COMMIT ANEMO_BUILT_AT=$ANEMO_BUILT_AT
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY shared ./shared
COPY docs ./docs
COPY server/src ./server/src
COPY server/assets ./server/assets
COPY server/migrations ./server/migrations
COPY server/package.json ./server/
COPY --from=web /app/web/dist ./web/dist
# Lizenz, Hinweise Dritter und SBOM liegen im Image unter /app (bzw. /app/third-party)
COPY LICENSE NOTICE ./
COPY --from=web /app/build/third-party ./third-party
EXPOSE 8080
USER nonroot
CMD ["server/src/main.ts"]
