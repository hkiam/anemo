import json, os, sys
out = sys.argv[1]
B = "http://jira.example.invalid"
def w(path, data):
    p = os.path.join(out, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(data, open(p, "w"), ensure_ascii=False, indent=1)
def user(name, display):
    return {"self": f"{B}/rest/api/2/user?username={name}", "name": name, "key": name,
            "emailAddress": f"{name}@example.org", "avatarUrls": {"48x48": f"{B}/secure/useravatar?owner={name}"},
            "displayName": display, "active": True, "timeZone": "Europe/Berlin"}
erika = user("emusterfrau", "Erika Musterfrau"); max_ = user("mmustermann", "Max Mustermann")
w("manifest.json", {"format": "anemo-zephyr-snapshot/1", "sourceSystem": "jira-zephyr", "baseUrl": B,
   "extractedAt": "2026-10-11T08:00:00.000Z", "anonymized": False, "projects": ["DEMO"]})
w("fields.json", [
 {"id": "summary", "name": "Zusammenfassung", "custom": False}, {"id": "description", "name": "Beschreibung", "custom": False},
 {"id": "customfield_10100", "name": "Epic Link", "custom": True, "schema": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link"}},
 {"id": "customfield_10101", "name": "Sprint", "custom": True, "schema": {"type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint"}},
 {"id": "customfield_10200", "name": "Testart", "custom": True, "schema": {"type": "option"}},
 {"id": "customfield_10201", "name": "Automatisierungsstatus", "custom": True, "schema": {"type": "option"}},
 {"id": "customfield_10300", "name": "Rang", "custom": True, "schema": {"type": "any"}},
])
w("execution-statuses.json", [
 {"id": 1, "name": "PASS", "description": "Test was executed and passed successfully.", "color": "#75B000", "type": 0},
 {"id": 2, "name": "FAIL", "description": "Test was executed and failed.", "color": "#CC3300", "type": 0},
 {"id": 3, "name": "WIP", "description": "Test execution is a work-in-progress.", "color": "#F2B000", "type": 0},
 {"id": 4, "name": "BLOCKED", "description": "The test execution of this test was blocked for some reason.", "color": "#6693B0", "type": 0},
 {"id": -1, "name": "UNEXECUTED", "description": "The test has not yet been executed.", "color": "#A0A0A0", "type": 0},
 {"id": 5, "name": "PASS MIT EINSCHRÄNKUNG", "description": "Bestanden, aber mit bekannter Abweichung.", "color": "#9ACD32", "type": 1},
])
w("projects/DEMO.json", {"self": f"{B}/rest/api/2/project/10000", "id": "10000", "key": "DEMO", "name": "Demo-Projekt",
  "description": "Fiktives Beispielprojekt für Migrationstests", "lead": max_,
  "components": [{"id": "10001", "name": "Weboberfläche"}, {"id": "10002", "name": "Suche"}],
  "versions": [{"id": "10010", "name": "7.3", "released": True}, {"id": "10011", "name": "7.4", "released": False}],
  "issueTypes": [{"id": "10005", "name": "Test"}]})
def status(n): return {"name": n, "id": "1", "statusCategory": {"key": "new"}}
def link(direction, key, summary, itype, typename, outward, inward):
    l = {"id": "1", "type": {"name": typename, "outward": outward, "inward": inward}}
    l[direction] = {"key": key, "fields": {"summary": summary, "status": {"name": "Offen"}, "issuetype": {"name": itype}}}
    return l
base = lambda: {"issuetype": {"name": "Test", "id": "10005"}, "project": {"id": "10000", "key": "DEMO", "name": "Demo-Projekt"},
  "watches": {"watchCount": 1, "isWatching": False}, "votes": {"votes": 0}, "workratio": -1, "lastViewed": None,
  "updated": "2026-10-01T10:00:00.000+0200", "progress": {"progress": 0, "total": 0}, "aggregateprogress": {"progress": 0, "total": 0},
  "timetracking": {}, "customfield_10300": None, "environment": None, "duedate": None, "resolution": None, "resolutiondate": None,
  "subtasks": [], "issuelinks": [], "attachment": [], "comment": {"comments": [], "total": 0}, "versions": [], "fixVersions": [],
  "labels": [], "components": [], "customfield_10100": None, "customfield_10101": None, "customfield_10200": None, "customfield_10201": None}
P = lambda title, body: "{panel:titleBGColor=#fafafa|title=!" + B + "/secure/attachment/1/icon.png! *" + title + "* }\n" + body + "\n{panel}\n"
d1 = (P("Allgemein", "Ein PDF-Dokument wird per Upload in einer geöffneten Akte abgelegt.") +
      P("Fokus / Abgrenzung", "*Was wird getestet:*\n- Upload von PDF\n- Ablage in der richtigen Akte") +
      P("Vorbedingungen", "- Eine Akte ist geöffnet\n- Der Benutzer besitzt Schreibrechte") +
      P("Technisches", " ") +
      P("Automation", "||ID||Testname||aktiv||\n|REG_0001|Weboberfläche.Upload.PDF_ablegen|ja|") +
      "\n|| Bearbeiter || Datum || Grund ||\n| EMU | 03.02.2025 | Schritt 2 angepasst (Hinweis von Max Mustermann) |\n")
issues = []
i1 = base(); i1.update({"summary": "PDF in Akte ablegen", "description": d1, "status": status("Fertig"), "priority": {"name": "Schwer"},
  "labels": ["Upload", "Akte", "QS-Board"], "components": [{"name": "Weboberfläche"}], "assignee": erika, "reporter": max_, "creator": max_,
  "created": "2024-03-01T09:00:00.000+0100", "versions": [{"id": "10010", "name": "7.3"}], "fixVersions": [{"id": "10011", "name": "7.4"}],
  "customfield_10100": "DEMO-10",
  "customfield_10101": ["com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,rapidViewId=3,state=CLOSED,name=QS Sprint 7.3,startDate=2026-09-01T00:00:00.000+02:00,endDate=2026-09-15T00:00:00.000+02:00,completeDate=<null>,sequence=7]"],
  "customfield_10200": {"self": f"{B}/rest/api/2/customFieldOption/1", "value": "Regressionstest", "id": "1"},
  "customfield_10201": {"value": "automatisiert", "id": "3"},
  "issuelinks": [link("inwardIssue", "DEMO-100", "PDF-Upload bricht bei Umlauten ab", "Bug", "Relates", "relates to", "relates to"),
                 link("outwardIssue", "DEMO-50", "Als Sachbearbeiter:in möchte ich PDFs ablegen", "Story", "Tests", "tests", "is tested by")],
  "subtasks": [{"key": "DEMO-2001", "fields": {"summary": "Testerstellung und -durchführung", "status": {"name": "Fertig"}}}],
  "attachment": [{"id": "4711", "filename": "screenshot-1.png", "mimeType": "image/png", "size": 10240, "content": f"{B}/secure/attachment/4711/screenshot-1.png", "author": erika, "created": "2024-03-02T10:00:00.000+0100"}],
  "comment": {"comments": [{"author": max_, "created": "2024-03-03T11:00:00.000+0100", "body": "Bitte mit [~emusterfrau] abstimmen, erika.musterfrau@example.org"}], "total": 1}})
issues.append(("DEMO-1", "20001", i1))
i2 = base(); i2.update({"summary": "Akte öffnen", "description": "Prüft das Öffnen einer bestehenden Akte über die Aktenzeichensuche.",
  "status": status("Fertig"), "priority": {"name": "Kritisch"}, "labels": ["Akte"], "components": [{"name": "Weboberfläche"}],
  "assignee": None, "reporter": erika, "creator": erika, "created": "2023-11-20T14:00:00.000+0100",
  "customfield_10200": {"value": "Smoketest", "id": "2"}})
issues.append(("DEMO-2", "20002", i2))
i3 = base(); i3.update({"summary": "Dokument versenden (alt)", "description": P("Allgemein", "Veraltete Fassung, ersetzt durch DEMO-6.") + P("Vorbedingungen", ""),
  "status": status("Outdated"), "priority": {"name": "Unwesentlich"}, "labels": [], "components": [{"name": "Weboberfläche"}],
  "assignee": None, "reporter": max_, "creator": max_, "created": "2021-05-05T08:00:00.000+0200", "customfield_10300": "0|i0003:",
  "resolution": {"name": "Outdated"}, "resolutiondate": "2025-01-10T09:00:00.000+0100"})
issues.append(("DEMO-3", "20003", i3))
i4 = base(); i4.update({"summary": "Suche nach Aktenzeichen", "description": P("Allgemein", "Suche mit vollständigem und unvollständigem Aktenzeichen.") + P("Testdaten", "AZ 4711/26, AZ 4711*"),
  "status": status("Review!"), "priority": {"name": "Schwer"}, "labels": ["Suche"], "components": [{"name": "Suche"}],
  "assignee": max_, "reporter": max_, "creator": max_, "created": "2025-02-02T08:00:00.000+0100", "environment": "Oracle 19c"})
issues.append(("DEMO-4", "20004", i4))
i5 = base(); i5.update({"summary": "Ablage ohne Schreibrechte wird verhindert", "description": None, "status": status("Offen"),
  "priority": {"name": "Schwer"}, "labels": ["Berechtigung", "Negativtest"], "components": [], "assignee": None, "reporter": erika, "creator": erika,
  "created": "2026-09-20T08:00:00.000+0200"})
issues.append(("DEMO-5", "20005", i5))
for key, iid, f in issues:
    w(f"issues/{key}.json", {"expand": "renderedFields,names,schema,operations,editmeta,changelog", "id": iid, "self": f"{B}/rest/api/2/issue/{iid}", "key": key, "fields": f,
       **({"changelog": {"startAt": 0, "maxResults": 1, "total": 1, "histories": [{"id": "1", "author": erika, "created": "2025-02-03T10:00:00.000+0100", "items": [{"field": "description", "fromString": "alt", "toString": "neu"}]}]}} if key == "DEMO-1" else {})})
def step(sid, order, s, d, r): return {"id": sid, "orderId": order, "step": s, "data": d, "result": r, "htmlStep": f"<p>{s}</p>", "htmlData": f"<p>{d}</p>", "htmlResult": f"<p>{r}</p>", "createdBy": "emusterfrau", "modifiedBy": "emusterfrau"}
w("teststeps/20001.json", [step(301, 1, "Akte DEMO/2026/1 öffnen", "", "Akte wird angezeigt"), step(302, 2, "PDF über 'Hochladen' auswählen", "beispiel.pdf (2 MB)", "Upload-Dialog zeigt Fortschritt"), step(303, 3, "Upload bestätigen", "", "Dokument erscheint in der Akte")])
w("teststeps/20002.json", [step(311, 1, "Benutzer anmelden", "Admin", "Dashboard erscheint"), step(312, 2, "Akte öffnen", "12345", "Akte wird angezeigt")])
w("teststeps/20003.json", [])
w("teststeps/20004.json", {"stepBeanCollection": [step(321, 1, "Aktenzeichen vollständig eingeben", "AZ 4711/26", "Genau ein Treffer"), step(322, 2, "Aktenzeichen mit Platzhalter eingeben", "AZ 4711*", "Alle passenden Akten werden gelistet")]})
w("teststeps/20005.json", [{"id": 331, "orderId": 1, "step": "Als Benutzer ohne Schreibrechte PDF hochladen", "data": "", "result": "Hinweis 'Keine Berechtigung'", "customFieldValues": {"Risiko": "hoch"}}])
cyc = lambda name, vid, vname, **kw: {"name": name, "description": kw.get("description", ""), "build": kw.get("build", ""), "environment": kw.get("environment", ""),
  "startDate": kw.get("startDate", ""), "endDate": kw.get("endDate", ""), "versionId": int(vid), "versionName": vname, "projectId": 10000, "projectKey": "DEMO",
  "createdBy": "mmustermann", "createdByDisplay": "Max Mustermann", "modifiedBy": "mmustermann", "totalExecutions": 0, "totalExecuted": 0, "started": "", "expand": "executionSummaries", "executionSummaries": {"executionSummary": []}}
w("cycles/DEMO/10010.json", {"-1": cyc("Ad hoc", "10010", "7.3"), "200": cyc("Regression 7.3", "10010", "7.3", build="7.3.0.117", environment="ORA", startDate="01/Sep/26", endDate="15/Sep/26", description="Vollregression vor Freigabe"), "recordsCount": 2})
w("cycles/DEMO/10011.json", {"201": cyc("Freigabetest 7.4", "10011", "7.4", build="7.4.0.3", environment="SQL", startDate="05/Okt/26", endDate="Q4"), "recordsCount": 1})
w("cycles/DEMO/-1.json", {"recordsCount": 0})
def ex(eid, order, issue, key, status, cid, vid, **kw):
    e = {"id": eid, "orderId": order, "executionStatus": str(status), "executedOn": kw.get("executedOn", ""), "executedBy": kw.get("by", ""), "executedByDisplay": kw.get("byDisplay", ""),
         "comment": kw.get("comment", ""), "htmlComment": kw.get("comment", ""), "cycleId": cid, "cycleName": "x", "issueId": issue, "issueKey": key, "summary": "x",
         "versionId": vid, "versionName": "x", "projectId": 10000, "projectKey": "DEMO", "label": "", "component": "", "assignedTo": kw.get("assignee", ""),
         "assignedToDisplay": "", "defects": kw.get("defects", []), "executionDefectCount": len(kw.get("defects", [])), "stepDefectCount": 0, "totalDefectCount": len(kw.get("defects", [])),
         "creationDate": "01/Sep/26", "createdBy": "mmustermann", "canViewIssue": True}
    if "executedOnVal" in kw: e["executedOnVal"] = kw["executedOnVal"]
    return e
statuses = {str(s["id"]): s for s in json.load(open(os.path.join(out, "execution-statuses.json")))}
w("executions/10010_200.json", {"status": statuses, "executions": [
  ex(9001, 1, 20001, "DEMO-1", 1, 200, 10010, executedOn="03/Sep/26 10:15 AM", by="emusterfrau", byDisplay="Erika Musterfrau"),
  ex(9002, 2, 20002, "DEMO-2", 2, 200, 10010, executedOn="03/Sep/26 2:30 PM", by="mmustermann", byDisplay="Max Mustermann", comment="Dashboard lädt nicht", defects=[{"key": "DEMO-101", "summary": "Dashboard bleibt leer", "status": "Offen"}]),
  ex(9003, 3, 20004, "DEMO-4", 5, 200, 10010, executedOn="04/Sep/26 9:00 AM", by="mmustermann", byDisplay="Max Mustermann", comment="Platzhaltersuche langsam (8 s)"),
]})
w("executions/10010_-1.json", {"status": statuses, "executions": [ex(9004, 1, 20005, "DEMO-5", 3, -1, 10010, assignee="emusterfrau")]})
w("executions/10011_201.json", {"status": statuses, "executions": [
  ex(9005, 1, 20001, "DEMO-1", -1, 201, 10011, assignee="emusterfrau"),
  ex(9006, 2, 20002, "DEMO-2", 1, 201, 10011, executedOnVal=1791100800000, by="emusterfrau", byDisplay="Erika Musterfrau"),
  ex(9007, 3, 20003, "DEMO-3", 4, 201, 10011, executedOn="06/Okt/26 11:00 AM", by="mmustermann", byDisplay="Max Mustermann", comment="Testumgebung SQL nicht erreichbar"),
]})
w("stepresults/9001.json", [{"id": 1, "stepId": 301, "executionId": 9001, "status": "1", "comment": ""}, {"id": 2, "stepId": 302, "executionId": 9001, "status": "1", "comment": "ok"}, {"id": 3, "stepId": 303, "executionId": 9001, "status": "1"}])
