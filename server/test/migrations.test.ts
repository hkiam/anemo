import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { it } from 'node:test';

/**
 * Schutz gegen nachträglich geänderte Migrationen: Prüfsummen bereits ausgelieferter Dateien sind
 * hier festgehalten. Neue Migrationen werden ergänzt, bestehende nie verändert.
 */
const FROZEN: Record<string, string> = {
  '019_agent_review.sql': '90b700887733c3e99f6fd5fd2b6782fe27a05f15e5edc767b2b0d74469b7d047',
  '020_app_setting.sql': 'ae7549b074f8fe7f8e28d23933196388177a73cc3474edd0013e20a3e6148fac',
  '021_stage_g.sql': '30d7b38258a010fcd09b287797d35bcb4b7483706464f03bd91603e37b4b1189',
  '022_review_findings.sql': '776bbbea5751cd45344edf9d1d2b1208e23f523c140e7b4a1879a7ba32027df6',
  '023_user_preference.sql': 'ff9892d8074b7077ce39696dd82dcf83ebb8aa5d98595d1b892ef83ec3ad7465',
  '024_stage_h.sql': '59c3c3c9f966b152d90bdf77dc847900c64b3a0d11cdf11601245b5bb0a297ee',
  '025_test_design.sql': '5e1dab82974b94e4d36bd0f0e250fd8f07f956a8921960a2100ecddf8dda6b65',
  '026_effort_adhoc.sql': '8220a05ce0b523e145a5212cbac7c5891c7c41454f43c58ce12ba52dc8ad3e28',
  '027_stage_i.sql': '397a0905acf2b63b9176b4f061b0b249bccd57d6948e4c45fc888c8a58274ec5',
  '028_plain_tests.sql': '2edf8ec08dcd9466e37b0cd0a32ac04008fcd2a91ed3cc7e8dc3f998b36dffc0',
  '029_review_fixes.sql': '5cb2f496658495c321fa069541da1c52d4444106917152c4730c26ba6a1b8fd3',
  '030_review_indexes.sql': '55bed061bc56477e2a26fe86ff7dc53f2a452c5fc855cafa4c0f7be81ff7d8b6',
  '031_accounts.sql': '7799254feb93cfa649bffe1c0d08805a6bfd07b9a5bcd29746ce1d1597187f57',
  '040_audit_baseline.sql': 'fa48caea29400a61be6342465f1cc2969818d3cf67e40c06f5635d480feb8971',
  '039_package_identity.sql': '39e97fe29a45dc098536b914900916f9a6e1fba7cf7a862aeaf689f204892f05',
  '038_project_transfer.sql': '7e8deb62660917b391979e9abd1b0bdf389a5612bada9555a1b197769d6e08f8',
  '037_known_failures_and_device.sql': 'cb97d554d9403949f9edd1555b339c3285dc7f342f0b687528825cedd5cdff3a',
  '036_defect_template_backlink.sql': '4f6e5da0d1c934439ce37a2e9ce90009daa65aea1e7769952fad6cca996a2123',
  '035_reference_per_step.sql': '2a0b4f5b6be1bccf1d7d6ae5589a8e8c281e85976e6fabcf7519d02ac5ad02bb',
  '034_reference_owner_project.sql': '2c1823b165e0cfd512f9cb1bcb0ff091af5ea1421145cc741b25a2244d345765',
  '033_field_templates.sql': '193bd00a1e21afc5f990bb3210cf2e21f142f535a56c6b0011955b0637efe64e',
  '032_version_pinning.sql': 'f7dab0e50192187d09abf32d584b9b0877e5ccc6e98205d94d3886892288a5b9',
  '018_gitlab_sync.sql': '9ed2e7e48b22dadcb3210b7fcf7e3c3a3bd494c7738ec56c10b901c6e1b51c29',
  '017_session_id_token.sql': 'be7b6ecef85234d2e6d94c7a5b56b07ef30ca71820d02d5f6e31f6db472ebae1',
  '016_oidc_login.sql': '0c3457283b8fe37511df4220852d89e66e390655f05cfaa18973419eeade7d93',
  '015_mail_notifications.sql': '45ea5b3bc223fac3333c3968d5ea2baaf65f595f2c10ee976fef40bcc8caac87',
  '014_saved_views.sql': 'ec1206f8b786d83afb1e87987af2cc1f04a3cb6e2b9537b7d5a481412d4d771f',
  '013_webhooks.sql': '22d989c1988a7a7ab868916a632d3b63b74171457eed9269c3eff7b8c20d1850',
  '012_api_tokens.sql': '5a218ace8d76debb966a952b9b20f3d8e1257ac19c595b0d24f63fad322a3c69',
  '011_report_profiles.sql': 'bcfb8a80beb9c0480d2e54985cb0d40369229b4a9260e16336c63ea5370f5063',
  '010_integrations_and_defect_templates.sql': 'da650b76dc4649cc42d83d8d90a6f8c14a0165758d9c95bf0302e5639ee8cce5',
  '009_project_sensitivity.sql': '0945ed4b793d826b89f91de58532127df2845bd54aac39f115e6906e5ead1747',
  '008_status_and_workflow.sql': 'a86e366c1d6b9c8960b7df78c0b9bf83ac5316ab39d7def56312de44e44979ed',
  '007_users_roles_permissions.sql': '3e48da33bd2e77e14dea3d1abdce6135f64a26386c8ade8392c800e3f792670d',
  '006_test_configurations.sql': '182df09328d8f690a533c363ed80dc97f9a95f905c7cee1748f508c24e716479',
  '005_repeated_executions.sql': 'e8e13818459a652c8e5c4e58761de0aefa2c9fca49ebb438f1552f19bca7ac61',
  '004_search_and_execution_views.sql': 'f852e78967e8f7dc0e95c631d8bb0215a9b0f1a73d1a71a5e9d07fb823ef2701',
  '003_source_record_payload_text.sql': '71b3a989f7c6aa3b22f501cef8b13974eb8099bf58337382e3b0fdb0bbfd4ba3',
  '002_attachment_source_key.sql': '38c6e9a8400b24da055c79fbc49ecada85c8c4e529510c1b5cbb4132336db368',
  '001_core_schema.sql': 'a541f8947ba7b07dbb40910a45f42ea2a31d2be1edea429a8f6e3845af5dfac7',
};

it('ausgelieferte SQL-Migrationen sind unverändert', async () => {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)), 'Namensschema NNN_name.sql');
  for (const [file, sum] of Object.entries(FROZEN)) {
    const actual = createHash('sha256').update(await readFile(new URL(file, dir))).digest('hex');
    assert.equal(actual, sum, `${file} wurde verändert – bitte stattdessen eine neue Migration anlegen`);
  }
});
