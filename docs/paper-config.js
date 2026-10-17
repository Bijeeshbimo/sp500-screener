// Paper trading connection settings.
// Leave both values empty to run in DEMO mode (everything is saved only in this browser, no login).
// To sync across devices: create a free Supabase project, run paper/schema.sql in its SQL editor, then paste
//   Project Settings -> API -> Project URL            into supabaseUrl
//   Project Settings -> API -> anon / public key      into supabaseAnonKey
// The anon key is meant to be public: your data is protected by your login and row-level security.
// NEVER put the service_role key here.
window.PAPER_CONFIG = {
  supabaseUrl: "https://qrnsadytlpqztljigqfx.supabase.co",
  supabaseAnonKey: "sb_publishable_4VHIMtGf4bblYYc7-Y5Aog_rkASFSKx",
};
