// Freddy's Seafood Grill & Restaurant — Supabase connection.
//
// Safe to be public. The publishable key only tells the browser which
// project to talk to; it is not a secret. What actually protects the data
// is Row Level Security plus the SECURITY DEFINER functions in
// supabase/migrations/ — see the security notes in README.md.

const SUPABASE_URL = "https://wuxsjsootynwgluzelpf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_NmXQA7w768KzaEyoVgk0bg_iM1ZB-G9";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
