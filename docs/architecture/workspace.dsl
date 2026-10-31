workspace "Anemo – Agentic QA Platform" "C4-Modell (Structurizr DSL). Rendern: docker run -it --rm -p 8081:8080 -v $PWD/docs/architecture:/usr/local/structurizr structurizr/lite" {

    model {
        qa = person "QA-Mitarbeiter:in" "Pflegt Testfälle, plant und führt Tests aus."
        po = person "Product Owner / Entwicklung" "Pflegt Anforderungen und Defects."
        agent = person "KI-Agent" "Claude, Codex oder eigene Agenten (ab Wave 3 über MCP)."

        jira = softwareSystem "Jira Server 7.1 + Zephyr for Jira 3.x" "Bestandssystem: Testfälle als Issues, Schritte/Zyklen/Ausführungen über ZAPI." "Extern"
        openproject = softwareSystem "OpenProject" "Künftiges Issue-/Projektmanagement (Wave 4)." "Extern"
        gitlab = softwareSystem "GitLab / Jenkins" "Quellcode, BDD-Features, CI-Ergebnisse (Wave 5)." "Extern"
        idp = softwareSystem "Identity Provider (OIDC)" "Anmeldung; Produkt noch offen." "Extern"
        llm = softwareSystem "LLM (on-prem / freigegeben)" "Für Copilot/Agenten ab Wave 7." "Extern"

        anemo = softwareSystem "Anemo" "QA-Plattform: System of Record für Testfälle, Versionen, Pläne, Ausführungen und Migration." {
            web = container "Web-UI" "Repository, Testfälle (klassisch/Gherkin), Zyklen, Ausführung, Migrationsbericht. Wird vom Backend ausgeliefert." "React, TypeScript, Vite" "Web"
            api = container "Backend" "Modularer Monolith mit REST/OpenAPI, ohne Build-Schritt." "Node 22 (TypeScript, Type-Stripping), Hono, zod" {
                projects = component "projects" "Projekte/Mandanten der QA-Domäne."
                testcases = component "testcases" "Ordnerbaum, Testfälle, unveränderliche Versionen, Suche, Gherkin-Parser und -Umwandlung."
                references = component "references" "ExternalReference zu Jira/OpenProject (Provider-Abstraktion)."
                execution = component "execution" "Testpläne, Zyklen, Ausführungen mit Schrittergebnissen."
                migration = component "migration" "Source Adapter, Raw Store, Normalizer, Verification, Report."
                events = component "events" "Domain-Event-Log (Outbox) und Audit-Trail."
                attachments = component "attachments" "Anhänge (lokal gespeichert oder Verweis auf Quellsystem)."
            }
            db = container "Datenbank" "Kanonisches Modell, Raw Store, Event-Log, Volltextsuche (german)." "PostgreSQL 18" "Database"
            files = container "Anhangsspeicher" "Binärdateien der Anhänge." "Volume" "Database"
            mcp = container "MCP-Server" "Agentenschnittstelle (geplant, Wave 3)." "MCP" "Geplant"
        }

        qa -> web "nutzt"
        po -> web "sieht Abdeckung"
        agent -> mcp "nutzt Tools"
        mcp -> api "REST"
        web -> api "REST/JSON"
        api -> db "SQL (postgres.js)"
        api -> files "liest/schreibt"
        api -> jira "liest Issues (REST v2) und Zephyr-Daten (ZAPI – derzeit nicht verfügbar, ADR-0009)" "HTTP"
        api -> openproject "liest/verknüpft Arbeitspakete (geplant)"
        api -> gitlab "liest Ergebnisse (geplant)"
        api -> llm "Vorschläge (geplant)"
        web -> idp "OIDC-Login (geplant)"

        testcases -> projects "gehört zu"
        testcases -> references "verknüpft"
        testcases -> events "publiziert"
        execution -> testcases "referenziert Version"
        execution -> references "Defects"
        execution -> events "publiziert"
        migration -> testcases "schreibt"
        migration -> execution "schreibt"
        migration -> references "schreibt"
        migration -> attachments "schreibt"
        execution -> attachments "Evidenzen"
        migration -> jira "extrahiert"
    }

    views {
        systemContext anemo "Kontext" { include * autolayout lr }
        container anemo "Container" { include * autolayout lr }
        component api "Komponenten" { include * autolayout lr }
        styles {
            element "Extern" { background #999999 color #ffffff }
            element "Geplant" { background #dddddd color #333333 border dashed }
            element "Database" { shape cylinder }
            element "Web" { shape WebBrowser }
        }
    }
}
