// The public question bank as static JSON for the practice-test island (spec 026).
// An invalid bank fails the build with the problem lines in the error.
import { loadQuestionBank } from '../../questions/bank.ts';

export const prerender = true;

export function GET(): Response {
  const questions = loadQuestionBank(__FIELD_GUIDE_QUESTIONS_DIR__, {
    diagramsDir: __FIELD_GUIDE_DIAGRAMS_DIR__,
    docsDir: __FIELD_GUIDE_DOCS_DIR__,
    labsDir: __FIELD_GUIDE_LABS_DIR__,
  });
  return new Response(JSON.stringify({ questions }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
