/**
 * Place `inserted` at `position` and renumber. Existing sections at or after
 * that position shift down by one, so the inserted section lands exactly where
 * the command asked. Sorting the combined list instead leaves two sections
 * sharing a position, and the tie-break can push the new section past the one
 * it was meant to precede -- while the INSERT still writes the requested
 * position, which the unique index then rejects.
 */
export function withSectionInserted<T extends { id: string; position: number }>(current: T[], inserted: T, position: number): T[] {
  return [...current.map((section) => ({ ...section, position: section.position >= position ? section.position + 1 : section.position })), inserted]
    .sort((a, b) => a.position - b.position)
    .map((section, index) => ({ ...section, position: index }));
}
