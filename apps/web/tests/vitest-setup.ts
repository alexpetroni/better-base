import path from 'node:path';
import { config } from 'dotenv';

// Integration tests read TEST_DATABASE_URL from the repo-root .env.
config({ path: path.resolve(import.meta.dirname, '../../../.env') });
