/**
 * "{count} {word}" pluralized — so a message doesn't have to spell out
 * "match(es)"/"thread(s)" by hand. Both forms are required rather than
 * guessed from the singular: English pluralization has enough exceptions
 * (and this project's own vocabulary has irregular ones like "entry") that
 * a heuristic would be wrong often enough to not be worth the one word it
 * saves at the call site.
 */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
