import PublicShell from "@/components/PublicShell";
import AnswersList from "@/components/AnswersList";

// Step 3 — drafted answers, confidence, citations, and .docx export.
export default function AnswersPage() {
  return (
    <PublicShell step={3}>
      <AnswersList />
    </PublicShell>
  );
}
