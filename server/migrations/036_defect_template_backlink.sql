-- Fehlervorlagen: Rückverweis als lesbarer Link auf den dauerhaften Anemo-Link (/go/…) statt nackter Adresse.
-- Nur Vorlagen mit der unveränderten Standardzeile; eigene Anpassungen bleiben unberührt.
update defect_template
set body_template = replace(body_template, 'Gemeldet aus Anemo von {{executedBy}}: {{link}}',
  '{{#link}}Aus Anemo: [{{testCase.key}} – {{testCase.title}}|{{link}}] · {{/link}}gemeldet von {{executedBy}}')
where body_template like '%Gemeldet aus Anemo von {{executedBy}}: {{link}}%';
