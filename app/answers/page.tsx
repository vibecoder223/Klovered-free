import PublicShell from "@/components/PublicShell";
import { PageHeader } from "@/components/ui";

// Step 3. Body (drafted answers + citations + export) is filled in Task 8.
export default function AnswersPage() {
  return (
    <PublicShell step={3}>
      <PageHeader
        title="Answers"
        sub="Review each drafted answer, its confidence, and its sources. Export when you are ready."
      />
    </PublicShell>
  );
}
