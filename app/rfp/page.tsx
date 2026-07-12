import PublicShell from "@/components/PublicShell";
import RfpUpload from "@/components/RfpUpload";

// Step 2 — RFP upload + extraction pipeline. PublicShell gates on session-ready.
export default function RfpPage() {
  return (
    <PublicShell step={2}>
      <RfpUpload />
    </PublicShell>
  );
}
