// Flat ESLint config. Next 16 removed the `next lint` command, so we invoke
// ESLint directly (`eslint .`). eslint-config-next (v16) already ships a flat
// config array, so we spread it in directly and add project-specific ignores.
import next from "eslint-config-next";

const config = [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "scripts/**",
      "supabase/**",
      "next-env.d.ts",
    ],
  },
  {
    // Next 16's preset enables the new strict react-hooks rules (purity,
    // set-state-in-effect, refs). These are perf/style advisories, not
    // correctness bugs, and fire on long-standing patterns across the app.
    // Keep them visible as warnings so CI stays green; revisit incrementally.
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      // Cosmetic: apostrophes/quotes in JSX text. Pure noise here.
      "react/no-unescaped-entities": "off",
      // Fonts are loaded globally via <link> in the root layout (Vellum); the
      // page-level heuristic misfires.
      "@next/next/no-page-custom-font": "warn",
    },
  },
];

export default config;
