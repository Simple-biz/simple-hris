/**
 * The column catalog of the ONE table outside systems may read — `global_master_list`.
 *
 * Kane, 2026-09-17: *"I can give them a whole table for the Global Master List or hide
 * some of those columns to protect data."* This file is the list an admin picks from.
 * A column appears in the Integrations picker ONLY when it is named here; a column
 * the picker cannot show, no key can ever receive.
 *
 * Three classes, and every real column of the table is in exactly one of them
 * (`catalog.test.ts` pins the full list against the live schema as read on 2026-09-17):
 *
 *  - ALWAYS  — `id`. It is the keyset cursor; a page cannot be walked without it.
 *  - OFFERABLE — what the admin chooses. Default is ALL of them ("the whole table");
 *    the admin hides by unticking. `sensitive` marks the ones that are personal
 *    contact / address / photo data so they stand out in the picker — it changes
 *    nothing at the API; a granted sensitive column goes out like any other.
 *  - NEVER — import bookkeeping and the off-boarding / deletion stamps. Not
 *    offerable, not returned, even to a whole-table key. `off_boarded_at` is still
 *    READ (the leaver filter needs it) and then projected away.
 *
 * Pure: no imports, so the tests run under `node --test` and the client bundle can
 * import it for the picker.
 */

export const GML_TABLE_KEY = 'global_master_list';
export const GML_TABLE_LABEL = 'Global Master List';

export type CatalogGroup = 'identity' | 'work' | 'contact' | 'address' | 'photo' | 'system';

export type CatalogColumn = {
  /** The exact column name as stored — spaces, capitals and the "Employement" typo included. */
  name: string;
  group: CatalogGroup;
  /** Personal contact / address / photo data. Marked in the picker; no API effect. */
  sensitive: boolean;
  description: string;
};

/** Columns EVERY key receives, whatever it was granted. `id` is the page cursor. */
export const ALWAYS_COLUMNS = ['id'] as const;

/** Columns NO key receives. Bookkeeping + the off-boarding/deletion stamps. */
export const NEVER_COLUMNS = [
  'import_batch_id',
  'source_file',
  'first_seen_upload_id',
  'last_seen_upload_id',
  'off_boarded_at',
  'off_boarded_reason',
  'off_boarded_by',
  'off_boarded_note',
  'scheduled_deletion_at',
  'deletion_processed_at',
] as const;

/** What the admin picks from, in picker order. */
export const GML_CATALOG: readonly CatalogColumn[] = [
  { name: 'Name', group: 'identity', sensitive: false, description: 'Full name as on the master sheet' },
  { name: 'employee_id', group: 'identity', sensitive: false, description: 'HRIS employee number' },
  { name: 'Department', group: 'work', sensitive: false, description: 'Department label as on the sheet' },
  { name: 'TeamIndex', group: 'work', sensitive: false, description: 'Team index within the department' },
  { name: 'Start Date', group: 'work', sensitive: false, description: 'First day' },
  { name: 'Tenure', group: 'work', sensitive: false, description: 'Tenure as written on the sheet' },
  { name: 'Employement Status', group: 'work', sensitive: false, description: 'Employment status (column name keeps the sheet spelling)' },
  { name: 'Location', group: 'work', sensitive: false, description: 'Work location / country' },
  { name: 'Work Email', group: 'contact', sensitive: false, description: 'Primary company email' },
  { name: 'Alternate Work Email', group: 'contact', sensitive: false, description: 'Second company email, if any' },
  { name: 'Alternate Work Email 2', group: 'contact', sensitive: false, description: 'Third company email, if any' },
  { name: 'Personal Email', group: 'contact', sensitive: true, description: 'Private email address' },
  { name: 'Contact Number', group: 'contact', sensitive: true, description: 'Phone as on the sheet' },
  { name: 'Phone Number', group: 'contact', sensitive: true, description: 'Phone as entered in onboarding' },
  { name: 'street', group: 'address', sensitive: true, description: 'Home street' },
  { name: 'city', group: 'address', sensitive: true, description: 'Home city' },
  { name: 'province', group: 'address', sensitive: true, description: 'Home province / state' },
  { name: 'postal_code', group: 'address', sensitive: true, description: 'Home postal code' },
  { name: 'full_address', group: 'address', sensitive: true, description: 'Home address, one line' },
  { name: 'Profile Photo URL', group: 'photo', sensitive: true, description: 'Profile photo (sheet)' },
  { name: 'google_photo_url', group: 'photo', sensitive: true, description: 'Profile photo (Google Workspace)' },
  { name: 'created_at', group: 'system', sensitive: false, description: 'When the HRIS row was created' },
];

export const OFFERABLE_COLUMNS: readonly string[] = GML_CATALOG.map((c) => c.name);
export const SENSITIVE_COLUMNS: readonly string[] = GML_CATALOG.filter((c) => c.sensitive).map((c) => c.name);

const OFFERABLE_SET = new Set<string>(OFFERABLE_COLUMNS);
const ALWAYS_SET = new Set<string>(ALWAYS_COLUMNS);
const NEVER_SET = new Set<string>(NEVER_COLUMNS);

export function isOfferable(column: string): boolean {
  return OFFERABLE_SET.has(column);
}
export function isAlways(column: string): boolean {
  return ALWAYS_SET.has(column);
}
export function isNever(column: string): boolean {
  return NEVER_SET.has(column);
}

/** Every column the catalog knows about, in one list — what the test compares to the live table. */
export const GML_KNOWN_COLUMNS: readonly string[] = [...ALWAYS_COLUMNS, ...OFFERABLE_COLUMNS, ...NEVER_COLUMNS];

export const GROUP_LABELS: Record<CatalogGroup, string> = {
  identity: 'Identity',
  work: 'Work',
  contact: 'Contact',
  address: 'Home address',
  photo: 'Photos',
  system: 'System',
};
