import PublicShell from "@/components/PublicShell";
import { PageHeader } from "@/components/ui";

// Step 2. Body (RFP upload + pipeline progress) is filled in Task 8.
export default function RfpPage() {
  return (
    <PublicShell step={2}>
      <PageHeader
        title="Upload RFP"
        sub="Upload the questionnaire you need answered. Klovered extracts each question and drafts a response."
      />
    </PublicShell>
  );
}
