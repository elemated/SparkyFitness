import { getClient } from '../db/poolManager.js';
import exerciseDb from './exercise.js';
import exerciseEntryDb from './exerciseEntry.js';
import { parseJsonArrayField } from '../utils/exerciseJsonFields.js';
const templateDbPath = './exerciseTemplate.js';
const { default: exerciseTemplateDb } = await import(templateDbPath);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExercisesNeedingReview(userId: any) {
  const client = await getClient(userId); // User-specific operation
  try {
    const result = await client.query(
      `SELECT DISTINCT ON (ee.exercise_id)
          ee.exercise_id,
          e.name AS exercise_name,
          e.calories_per_hour AS exercise_calories_per_hour,
          e.updated_at AS exercise_updated_at,
          ee.created_at AS entry_created_at,
          e.user_id AS exercise_owner_id
       FROM exercise_entries ee
       JOIN exercises e ON ee.exercise_id = e.id
       WHERE ee.user_id = $1
         AND e.updated_at > ee.created_at -- Exercise has been updated since the entry was created
         AND NOT EXISTS (
             SELECT 1 FROM user_ignored_updates uiu
             WHERE uiu.user_id = $1
               AND uiu.variant_id = ee.exercise_id -- Using exercise_id as variant_id for exercises
               AND uiu.ignored_at_timestamp = e.updated_at
         )
       ORDER BY ee.exercise_id, ee.created_at DESC`,
      [userId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}
async function updateExerciseEntriesSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exerciseId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newSnapshotData: any
) {
  const client = await getClient(userId); // User-specific operation
  try {
    const result = await client.query(
      `UPDATE exercise_entries
       SET
          exercise_name = $1,
          calories_per_hour = $2,
          modality = $3
       WHERE user_id = $4 AND exercise_id = $5
       RETURNING id`,
      [
        newSnapshotData.exercise_name,
        newSnapshotData.calories_per_hour,
        newSnapshotData.modality,
        userId,
        exerciseId,
      ]
    );
    return result.rowCount;
  } finally {
    client.release();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function clearUserIgnoredUpdate(userId: any, variantId: any) {
  const client = await getClient(userId); // User-specific operation
  try {
    await client.query(
      `DELETE FROM user_ignored_updates
       WHERE user_id = $1 AND variant_id = $2`,
      [userId, variantId]
    );
  } finally {
    client.release();
  }
}

// Entries whose calories_burned must never be replaced by the formula: a
// device measured it (active_calories, as the watch writes it), it came from a
// provider sync (any source other than manual), or it is calorie-linked to
// another entry, whose counted calories are derived from this estimate.
const KEPT_CALORIES_SQL = `(ee.active_calories IS NOT NULL
  OR ee.calorie_link_id IS NOT NULL
  OR (ee.source IS NOT NULL AND lower(ee.source) NOT IN ('manual', 'sparky')))`;
// $1 = calories_per_hour, $2 = recompute flag.
const RECOMPUTE_SQL = `($2::boolean AND $1::numeric IS NOT NULL
  AND ee.duration_minutes > 0 AND NOT ${KEPT_CALORIES_SQL})`;
const RECOMPUTED_CALORIES_SQL =
  'ROUND($1::numeric * ee.duration_minutes / 60, 1)';

interface ExerciseEntrySyncSummary {
  entry_count: number;
  recomputed_count: number;
  kept_measured_count: number;
  no_duration_count: number;
  calories_before: number;
  calories_after: number;
}

interface ExerciseEntrySnapshot {
  exercise_name: string;
  calories_per_hour: number | null;
  modality: string | null;
}

function toSyncSummary(row: Record<string, unknown>): ExerciseEntrySyncSummary {
  return {
    entry_count: Number(row.entry_count ?? 0),
    recomputed_count: Number(row.recomputed_count ?? 0),
    kept_measured_count: Number(row.kept_measured_count ?? 0),
    no_duration_count: Number(row.no_duration_count ?? 0),
    calories_before: Number(row.calories_before ?? 0),
    calories_after: Number(row.calories_after ?? 0),
  };
}

const SYNC_SUMMARY_COLUMNS = `
  COUNT(*)::int AS entry_count,
  COUNT(*) FILTER (WHERE recompute)::int AS recomputed_count,
  COUNT(*) FILTER (WHERE kept)::int AS kept_measured_count,
  COUNT(*) FILTER (WHERE NOT kept AND NOT (duration_minutes > 0))::int AS no_duration_count,
  COALESCE(SUM(calories_before), 0)::float8 AS calories_before,
  COALESCE(SUM(calories_after), 0)::float8 AS calories_after`;

/**
 * What sync_exercise_entries would do to this user's diary entries for one
 * exercise, without writing: how many entries, and the calorie total before
 * and after (unchanged unless `recomputeCalories`).
 */
async function getExerciseEntrySyncPreview(
  userId: string,
  exerciseId: string,
  caloriesPerHour: number | null,
  recomputeCalories: boolean
): Promise<ExerciseEntrySyncSummary> {
  const client = await getClient(userId);
  try {
    const result = await client.query(
      `SELECT ${SYNC_SUMMARY_COLUMNS}
       FROM (
         SELECT ee.duration_minutes,
                ${KEPT_CALORIES_SQL} AS kept,
                ${RECOMPUTE_SQL} AS recompute,
                ee.calories_burned AS calories_before,
                CASE WHEN ${RECOMPUTE_SQL} THEN ${RECOMPUTED_CALORIES_SQL}
                     ELSE ee.calories_burned END AS calories_after
         FROM exercise_entries ee
         WHERE ee.user_id = $3 AND ee.exercise_id = $4
       ) s`,
      [caloriesPerHour, recomputeCalories, userId, exerciseId]
    );
    return toSyncSummary(result.rows[0] ?? {});
  } finally {
    client.release();
  }
}

/**
 * Copies the exercise's name, calories per hour and modality onto this user's
 * diary entries for it (the same snapshot updateExerciseEntriesSnapshot
 * writes) and, with `recomputeCalories`, sets calories_burned to
 * calories_per_hour x duration for entries that have a duration and no
 * measured or linked calories. One transaction, which also clears the
 * user's "ignore this update" marker for the exercise.
 */
async function syncExerciseEntriesWithExercise(
  userId: string,
  exerciseId: string,
  snapshot: ExerciseEntrySnapshot,
  recomputeCalories: boolean
): Promise<ExerciseEntrySyncSummary> {
  const client = await getClient(userId);
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH target AS (
         SELECT ee.id, ee.duration_minutes,
                ee.calories_burned AS calories_before,
                ${KEPT_CALORIES_SQL} AS kept,
                ${RECOMPUTE_SQL} AS recompute
         FROM exercise_entries ee
         WHERE ee.user_id = $3 AND ee.exercise_id = $4
         FOR UPDATE
       ), updated AS (
         UPDATE exercise_entries ee
         SET exercise_name = $5,
             calories_per_hour = $1,
             modality = $6,
             calories_burned = CASE WHEN target.recompute
                                    THEN ${RECOMPUTED_CALORIES_SQL}
                                    ELSE ee.calories_burned END
         FROM target
         WHERE ee.id = target.id
         RETURNING ee.calories_burned AS calories_after, target.calories_before,
                   target.kept, target.recompute, target.duration_minutes
       )
       SELECT ${SYNC_SUMMARY_COLUMNS} FROM updated`,
      [
        snapshot.calories_per_hour,
        recomputeCalories,
        userId,
        exerciseId,
        snapshot.exercise_name,
        snapshot.modality,
      ]
    );
    await client.query(
      `DELETE FROM user_ignored_updates
       WHERE user_id = $1 AND variant_id = $2`,
      [userId, exerciseId]
    );
    await client.query('COMMIT');
    return toSyncSummary(result.rows[0] ?? {});
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function imagePaths(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : parseJsonArrayField(typeof raw === 'string' ? raw : null, 'images');
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * Reads and rewrites one owned exercise's images under a row lock, so two
 * concurrent image edits cannot drop each other's change. Returns null when
 * the exercise is not the user's own, or when `edit` returns null (nothing to
 * write).
 */
async function editOwnedExerciseImages<T>(
  userId: string,
  exerciseId: string,
  edit: (images: string[]) => { images: string[]; result: T } | null
): Promise<{ images: string[]; result: T } | null> {
  const client = await getClient(userId);
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT images FROM exercises WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [exerciseId, userId]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const outcome = edit(imagePaths(current.rows[0].images));
    if (!outcome) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE exercises SET images = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3`,
      [JSON.stringify(outcome.images), exerciseId, userId]
    );
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Appends an image path to an exercise the user owns; null if not owned. */
async function appendExerciseImage(
  userId: string,
  exerciseId: string,
  imagePath: string
): Promise<{ images: string[]; index: number } | null> {
  const outcome = await editOwnedExerciseImages(
    userId,
    exerciseId,
    (images) => ({
      images: [...images, imagePath],
      result: images.length,
    })
  );
  return outcome ? { images: outcome.images, index: outcome.result } : null;
}

/**
 * Removes one image reference from an exercise the user owns. The file itself
 * is left on disk. `index` and `imagePath` must agree when both are given.
 * Returns null when the exercise is not owned or no image matches.
 */
async function removeExerciseImage(
  userId: string,
  exerciseId: string,
  target: { index?: number; imagePath?: string }
): Promise<{ images: string[]; removed: string; index: number } | null> {
  const outcome = await editOwnedExerciseImages(
    userId,
    exerciseId,
    (images) => {
      const index =
        target.index !== undefined
          ? target.index
          : images.indexOf(target.imagePath as string);
      if (index < 0 || index >= images.length) return null;
      if (
        target.imagePath !== undefined &&
        images[index] !== target.imagePath
      ) {
        return null;
      }
      return {
        images: images.filter((_, i) => i !== index),
        result: { removed: images[index], index },
      };
    }
  );
  return outcome ? { images: outcome.images, ...outcome.result } : null;
}

export const deleteExerciseAndDependencies =
  exerciseDb.deleteExerciseAndDependencies;
export const getExerciseDeletionImpact = exerciseDb.getExerciseDeletionImpact;
export { getExercisesNeedingReview };
export { updateExerciseEntriesSnapshot };
export { clearUserIgnoredUpdate };
export {
  getExerciseEntrySyncPreview,
  syncExerciseEntriesWithExercise,
  appendExerciseImage,
  removeExerciseImage,
};
export type { ExerciseEntrySyncSummary };
export default {
  ...exerciseDb,
  ...exerciseEntryDb,
  ...exerciseTemplateDb,
  getExercisesNeedingReview,
  updateExerciseEntriesSnapshot,
  clearUserIgnoredUpdate,
  getExerciseEntrySyncPreview,
  syncExerciseEntriesWithExercise,
  appendExerciseImage,
  removeExerciseImage,
  deleteExerciseAndDependencies,
  getExerciseDeletionImpact,
};
