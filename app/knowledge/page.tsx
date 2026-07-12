import PublicShell from "@/components/PublicShell";
import { PageHeader } from "@/components/ui";

// Step 1. Body (the knowledge library + upload) is filled in Task 7.
export default function KnowledgePage() {
  return (
    <PublicShell step={1}>
      <PageHeader
        title="Add knowledge"
        sub="Upload the documents Klovered should answer from: past proposals, product docs, security policies."
      />
    </PublicShell>
  );
}
