import { config } from './config.ts';
import { connect } from './db.ts';
import { migrate } from './migrate.ts';

const db = connect(config.databaseUrl, { max: 1, connection: { statement_timeout: 0 } });
try {
  const applied = await migrate(db, console.log);
  console.log(applied.length ? `${applied.length} Migration(en) angewendet.` : 'Schema ist aktuell.');
} finally {
  await db.end();
}
