import { redirect } from "next/navigation";

// The public tool starts at step 1. The root path just forwards there.
export default function Home() {
  redirect("/knowledge");
}
