import { supabase } from "./supabaseClient.js";

async function testConnection() {
  // Lightweight read to verify API + database access.
  const { data, error } = await supabase
    .from("organizations")
    .select("id", { count: "exact" })
    .limit(1);

  if (error) {
    console.error("Supabase connection test failed:");
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  console.log("Supabase connection successful.");
  console.log(`organizations query returned ${data.length} row(s) in sample.`);
}

testConnection().catch((err) => {
  console.error("Unexpected error during Supabase test:");
  console.error(err.message);
  process.exitCode = 1;
});
