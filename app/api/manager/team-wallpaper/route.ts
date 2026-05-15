import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "manager_team_wallpapers";

// Cap is keyed off the raw file size now that uploads use multipart/form-data
// (the encoded data URL stored in the table is ~33% larger but that's a
// server-side detail, not a transport concern).
const MAX_BYTES = 10 * 1024 * 1024;

function getSb() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** GET ?department=X — returns the saved wallpaper data URL for a department.
 *  Any authenticated session can read (mirrors the team-list visibility). */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const department = req.nextUrl.searchParams.get("department")?.trim();
  if (!department) return NextResponse.json({ url: null });

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ url: null });

  const { data, error } = await supabase
    .from(TABLE)
    .select("image_data_url, background_position")
    .ilike("department", department)
    .maybeSingle();
  if (error) return NextResponse.json({ url: null, error: error.message }, { status: 500 });
  const row = data as { image_data_url?: string | null; background_position?: string | null } | null;
  return NextResponse.json({
    url: row?.image_data_url ?? null,
    position: row?.background_position ?? "50% 50%",
  });
}

/** POST multipart/form-data { department, file } — upserts the wallpaper for a
 *  department. Multipart is used instead of JSON because Next.js App Router
 *  silently truncates large JSON bodies, producing an "unterminated string"
 *  parse error mid-base64. FormData streams binary cleanly.
 *  Any authenticated session can write — team wallpaper is shared identity,
 *  not sensitive data. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Could not parse multipart body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const department = String(form.get("department") ?? "").trim();
  const file = form.get("file");

  if (!department) return NextResponse.json({ error: "department is required" }, { status: 400 });
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "file must be an image" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image must be under ${Math.round(MAX_BYTES / (1024 * 1024))} MB.` },
      { status: 413 },
    );
  }

  // Encode to a data URL server-side so the table schema stays unchanged.
  const ab = await file.arrayBuffer();
  const base64 = Buffer.from(ab).toString("base64");
  const dataUrl = `data:${file.type};base64,${base64}`;

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ error: "supabase unavailable" }, { status: 500 });

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        department,
        image_data_url: dataUrl,
        updated_by: session.user.email ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "department" },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

/** PATCH { department, position } — updates the saved background-position
 *  string for a department's wallpaper without re-uploading the image.
 *  Used by the drag-to-reposition UI in the My Team banner. */
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { department?: string; position?: string } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch (e) {
    return NextResponse.json(
      { error: `Could not parse body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const department = (body.department ?? "").trim();
  const position = (body.position ?? "").trim();

  if (!department) return NextResponse.json({ error: "department is required" }, { status: 400 });
  // Permissive but bounded — accept `"<num>% <num>%"`. Anything else means a
  // bug in the client; reject so corrupt values never persist.
  if (!/^-?\d+(\.\d+)?% -?\d+(\.\d+)?%$/.test(position)) {
    return NextResponse.json({ error: "position must be a CSS background-position string like '30% 70%'" }, { status: 400 });
  }

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ error: "supabase unavailable" }, { status: 500 });

  const { error } = await supabase
    .from(TABLE)
    .update({ background_position: position, updated_at: new Date().toISOString() })
    .ilike("department", department);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

/** DELETE ?department=X — removes the wallpaper. */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const department = req.nextUrl.searchParams.get("department")?.trim();
  if (!department) return NextResponse.json({ error: "department is required" }, { status: 400 });

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ error: "supabase unavailable" }, { status: 500 });

  const { error } = await supabase.from(TABLE).delete().ilike("department", department);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
