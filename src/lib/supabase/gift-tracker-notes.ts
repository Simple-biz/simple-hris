import { createSupabaseServiceRoleClient } from './server';

export type GiftTrackerNote = {
  personal_email: string;
  note: string;
  updated_by: string | null;
  updated_at: string;
};

export async function listGiftTrackerNotes(): Promise<{
  notes: GiftTrackerNote[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { notes: [], error: 'Supabase client unavailable' };
  const { data, error } = await supabase
    .from('gift_tracker_notes')
    .select('personal_email, note, updated_by, updated_at');
  if (error) return { notes: [], error: error.message };
  return { notes: (data ?? []) as GiftTrackerNote[], error: null };
}

export async function upsertGiftTrackerNote(
  personalEmail: string,
  note: string,
  updatedBy: string | null,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('gift_tracker_notes')
    .upsert(
      {
        personal_email: personalEmail.trim().toLowerCase(),
        note,
        updated_by: updatedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'personal_email' },
    );
  return { error: error ? error.message : null };
}
