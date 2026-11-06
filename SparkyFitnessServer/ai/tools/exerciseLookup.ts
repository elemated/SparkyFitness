import exerciseService from '../../services/exerciseService.js';

// Every visible exercise whose name matches case-insensitively (MCP's
// `name ILIKE $1` without wildcards). The server search returns substring
// matches; the exact matches, when present, are always among them.
export async function findExercisesByExactName(userId: string, name: string) {
  const rows = await exerciseService.searchExercises(
    userId,
    name,
    userId,
    undefined,
    undefined
  );
  return rows.filter(
    (e: { name: unknown }) =>
      String(e.name).toLowerCase() === name.toLowerCase()
  );
}

// The first exact match, for actions that accept any visible exercise.
export async function findExerciseByExactName(userId: string, name: string) {
  const [first] = await findExercisesByExactName(userId, name);
  return first;
}
