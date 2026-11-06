import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply({ error: "Sign in as a chapter administrator first." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceRoleKey) return reply({ error: "Server authentication is not configured." }, 500);

  const callerClient = createClient(url, publishableKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const token = authorization.slice("Bearer ".length);
  const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser(token);
  if (callerError || !caller || caller.app_metadata?.chapter_role !== "admin") {
    return reply({ error: "Only a chapter administrator can create member accounts." }, 403);
  }

  const adminClient = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { data: profile, error: profileError } = await adminClient
    .from("profiles").select("is_active, role").eq("id", caller.id).maybeSingle();
  if (profileError || !profile?.is_active || profile.role !== "admin") {
    return reply({ error: "Your chapter administrator profile is inactive or not configured." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16_384) return reply({ error: "Request is too large." }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply({ error: "Enter the member details as an object." }, 400);
    body = parsed as Record<string, unknown>;
  } catch { return reply({ error: "Invalid request body." }, 400); }
  if (['full_name','email','password','chapter_position'].some(key => typeof body[key] !== 'string')) return reply({ error: "Member details must be text." }, 400);
  const fullName = String(body.full_name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const position = String(body.chapter_position ?? "").trim();
  if (position !== 'Member') return reply({ error: 'Create the account as Member, then assign elected positions from 7 Masters.' }, 400);
  if (fullName.length < 2 || fullName.length > 120 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128 || position.length < 2 || position.length > 80) {
    return reply({ error: "Enter a valid name, email, password of at least 8 characters, and chapter position." }, 400);
  }

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { chapter_role: "member" },
    user_metadata: { full_name: fullName, chapter_position: position },
  });
  if (error) return reply({ error: error.message }, 400);
  // This project has no Auth-to-profile trigger. Provision the live profile explicitly.
  const { error: createProfileError } = await adminClient.from('profiles').upsert({
    id: data.user.id, email, full_name: fullName, chapter_position: position, role: 'member', is_active: true,
  }, { onConflict: 'id' });
  if (createProfileError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(data.user.id);
    if (cleanupError) console.error('Member profile provisioning and account rollback failed', { userId: data.user.id });
    return reply({ error: cleanupError ? 'Account setup was incomplete. Ask the project owner to repair the member profile before retrying.' : 'Could not create the member profile. No login was retained; please try again.' }, 500);
  }
  return reply({ id: data.user.id, email: data.user.email, full_name: fullName, chapter_position: position, role: "member" }, 201);
});
