import { vi, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { buildExerciseTools } from '../ai/tools/exerciseTools.js';
import exerciseService from '../services/exerciseService.js';
import exerciseDb from '../models/exercise.js';
import {
  appendExerciseImage,
  getExerciseEntrySyncPreview,
  removeExerciseImage,
  syncExerciseEntriesWithExercise,
} from '../models/exerciseRepository.js';
import { downloadUserSuppliedImage } from '../utils/imageDownloader.js';
import { OutboundUrlBlockedError } from '../utils/outboundUrlPolicy.js';
import { UPLOADS_BASE_DIR } from '../utils/uploadsPath.js';
import { toolOpts as opts } from './helpers/toolExecutionOptions.js';

vi.mock('../services/exerciseService', () => ({
  default: {
    searchExercises: vi.fn(),
    getExerciseById: vi.fn(),
    updateExercise: vi.fn(),
  },
}));
vi.mock('../models/exercise', () => ({
  default: { getExerciseOwnerId: vi.fn() },
}));
vi.mock('../models/exerciseEntry', () => ({ default: {} }));
vi.mock('../models/workoutPresetRepository', () => ({ default: {} }));
vi.mock('../models/exerciseRepository', () => ({
  getExerciseEntrySyncPreview: vi.fn(),
  syncExerciseEntriesWithExercise: vi.fn(),
  appendExerciseImage: vi.fn(),
  removeExerciseImage: vi.fn(),
  default: {},
}));
vi.mock('../utils/imageDownloader', () => ({
  downloadUserSuppliedImage: vi.fn(),
}));
vi.mock('../services/workoutPresetService', () => ({ default: {} }));
vi.mock('../services/exerciseCalorieRangeService', () => ({
  getResolvedExerciseCaloriesRange: vi.fn(),
  getResolvedExerciseCaloriesTotal: vi.fn(),
}));
vi.mock('../services/exerciseAlternativesService', () => ({
  getExerciseAlternatives: vi.fn(),
}));
vi.mock('../services/workoutCoachingService', () => ({
  setWorkoutFeedbackForEntry: vi.fn(),
  WorkoutEntryNotInSessionError: class extends Error {},
  WorkoutSessionNotFoundError: class extends Error {},
}));
vi.mock('../services/adaptiveWorkoutService', () => ({
  getWorkoutCoachingSignals: vi.fn(),
}));
vi.mock('../config/logging', () => ({ log: vi.fn() }));

const USER = 'user-1';
const EX_ID = '22222222-2222-4222-8222-222222222222';
const EX_ID_2 = '33333333-3333-4333-8333-333333333333';
const IMAGE_PATH = `/uploads/exercises/${EX_ID}/0b7e1c1e-1111-4111-8111-111111111111.png`;

const OWNED_ROW = {
  id: EX_ID,
  name: 'Bench Press',
  category: 'Strength',
  calories_per_hour: '300',
  description: 'Old',
  modality: 'weight_reps',
  equipment: '["Barbell"]',
  primary_muscles: '["chest"]',
  secondary_muscles: null,
  images: ['/uploads/exercises/a.png', '/uploads/exercises/b.png'],
  user_id: USER,
  shared_with_public: false,
};

const SUMMARY = {
  entry_count: 5,
  recomputed_count: 3,
  kept_measured_count: 1,
  no_duration_count: 1,
  calories_before: 900,
  calories_after: 1150.4,
};

let tools: ReturnType<typeof buildExerciseTools>;

function run(args: Record<string, unknown>) {
  return tools.sparky_manage_exercise.execute!(args, opts);
}

function givenOwnedExercise(row: Record<string, unknown> = OWNED_ROW) {
  vi.mocked(exerciseService.getExerciseById).mockResolvedValue(row);
  vi.mocked(exerciseDb.getExerciseOwnerId).mockResolvedValue(row.user_id);
}

function expectNoWrites() {
  expect(exerciseService.updateExercise).not.toHaveBeenCalled();
  expect(syncExerciseEntriesWithExercise).not.toHaveBeenCalled();
  expect(appendExerciseImage).not.toHaveBeenCalled();
  expect(removeExerciseImage).not.toHaveBeenCalled();
  expect(downloadUserSuppliedImage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  tools = buildExerciseTools(USER, 'UTC');
});

describe('update_exercise', () => {
  it('returns the candidates and changes nothing when the name is ambiguous', async () => {
    vi.mocked(exerciseService.searchExercises).mockResolvedValue([
      { id: EX_ID, name: 'Bench Press', user_id: USER, category: 'Strength' },
      { id: EX_ID_2, name: 'bench press', user_id: null, category: 'Strength' },
      { id: 'other', name: 'Bench Press Incline', user_id: USER },
    ]);

    const result = await run({
      action: 'update_exercise',
      exercise_name: 'Bench Press',
      calories_per_hour: 450,
      confirmed: true,
    });

    expect(result).toBe(
      'Several exercises are named "Bench Press":\n' +
        `- Bench Press (ID: ${EX_ID}, yours, Strength)\n` +
        `- bench press (ID: ${EX_ID_2}, System, Strength)\n\n` +
        'Ask the user which one they mean, then call update_exercise again with its exercise_id. Nothing was changed.'
    );
    expect(exerciseService.getExerciseById).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('resolves a single exact name match', async () => {
    vi.mocked(exerciseService.searchExercises).mockResolvedValue([
      { id: EX_ID, name: 'Bench Press', user_id: USER },
      { id: 'other', name: 'Bench Press Incline', user_id: USER },
    ]);
    givenOwnedExercise();

    const result = await run({
      action: 'update_exercise',
      exercise_name: 'bench press',
      calories_per_hour: 450,
    });

    expect(exerciseService.getExerciseById).toHaveBeenCalledWith(USER, EX_ID);
    expect(result).toContain('Preview of changes to "Bench Press"');
  });

  it('previews before/after without writing when not confirmed', async () => {
    givenOwnedExercise();

    const result = await run({
      action: 'update_exercise',
      exercise_id: EX_ID,
      category: 'Strength',
      calories_per_hour: 450,
      equipment: 'Barbell, Bench',
    });

    expect(result).toBe(
      `Preview of changes to "Bench Press" (ID: ${EX_ID}):\n` +
        '- calories_per_hour: 300 → 450\n' +
        '- equipment: Barbell → Barbell, Bench\n\n' +
        'Diary entries keep their own copy of the exercise and are not changed by this. ' +
        'Confirm with the user first. If they agree, call update_exercise again with the same fields and confirmed=true. Nothing was changed.'
    );
    expectNoWrites();
  });

  it('applies only the changed fields when confirmed and never touches diary entries', async () => {
    givenOwnedExercise();
    vi.mocked(exerciseService.updateExercise).mockResolvedValue({
      ...OWNED_ROW,
      name: 'Flat Bench Press',
      calories_per_hour: '450',
      primary_muscles: '["chest","triceps"]',
    });

    const result = await run({
      action: 'update_exercise',
      exercise_id: EX_ID,
      confirmed: true,
      name: 'Flat Bench Press',
      category: 'Strength',
      calories_per_hour: 450,
      primary_muscles: ['chest', 'triceps'],
    });

    expect(exerciseService.updateExercise).toHaveBeenCalledWith(USER, EX_ID, {
      name: 'Flat Bench Press',
      calories_per_hour: 450,
      primary_muscles: ['chest', 'triceps'],
    });
    expect(result).toBe(
      `✅ Exercise "Flat Bench Press" updated (ID: ${EX_ID}):\n` +
        '- name: Bench Press → Flat Bench Press\n' +
        '- calories_per_hour: 300 → 450\n' +
        '- primary_muscles: chest → chest, triceps\n\n' +
        'Diary entries were not changed. To copy the new name or calories per hour onto logged entries, use sync_exercise_entries.'
    );
    expect(syncExerciseEntriesWithExercise).not.toHaveBeenCalled();
    expect(getExerciseEntrySyncPreview).not.toHaveBeenCalled();
  });

  it.each([
    [null, false, 'a built-in System exercise'],
    ['someone-else', true, 'a public exercise shared by another user'],
    ['someone-else', false, 'shared with you by another user'],
  ])(
    'refuses an exercise owned by %s (public=%s) even when confirmed',
    async (owner, isPublic, kind) => {
      vi.mocked(exerciseService.getExerciseById).mockResolvedValue({
        ...OWNED_ROW,
        user_id: owner,
        shared_with_public: isPublic,
      });
      vi.mocked(exerciseDb.getExerciseOwnerId).mockResolvedValue(owner);

      const result = await run({
        action: 'update_exercise',
        exercise_id: EX_ID,
        calories_per_hour: 450,
        confirmed: true,
      });

      expect(result).toBe(
        `Error [FORBIDDEN]: "Bench Press" is ${kind}. Only exercises you own can be changed. Use duplicate_exercise to make your own copy and edit that instead. Nothing was changed.`
      );
      expectNoWrites();
    }
  );

  it('reports when the values already match', async () => {
    givenOwnedExercise();
    const result = await run({
      action: 'update_exercise',
      exercise_id: EX_ID,
      calories_per_hour: 300,
      equipment: ['Barbell'],
      confirmed: true,
    });
    expect(result).toBe(
      '"Bench Press" already has these values. Nothing was changed.'
    );
    expectNoWrites();
  });

  it('requires at least one field', async () => {
    givenOwnedExercise();
    const result = await run({ action: 'update_exercise', exercise_id: EX_ID });
    expect(result).toMatch(/^Error \[VALIDATION\]: Provide at least one field/);
    expectNoWrites();
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    vi.mocked(exerciseService.getExerciseById).mockRejectedValue(
      new Error('Exercise not found.')
    );
    const result = await run({
      action: 'update_exercise',
      exercise_id: EX_ID,
      name: 'X',
      confirmed: true,
    });
    expect(result).toBe(
      `Error [NOT_FOUND]: Exercise with ID '${EX_ID}' not found.\n\nSuggestion: Check the ID and try again.`
    );
    expectNoWrites();
  });
});

describe('sync_exercise_entries', () => {
  it('previews entry count and calorie totals without writing', async () => {
    givenOwnedExercise({ ...OWNED_ROW, calories_per_hour: '400' });
    vi.mocked(getExerciseEntrySyncPreview).mockResolvedValue(SUMMARY);

    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
      recompute_calories: true,
    });

    expect(getExerciseEntrySyncPreview).toHaveBeenCalledWith(
      USER,
      EX_ID,
      400,
      true
    );
    expect(result).toBe(
      `Preview of syncing diary entries with "Bench Press" (ID: ${EX_ID}):\n` +
        '- Entries: 5\n' +
        '- Calorie total: 900 kcal → 1150.4 kcal\n' +
        '- Recomputed (calories_per_hour × duration): 3\n' +
        '- Kept (measured, synced or linked calories): 1\n' +
        '- Kept (no duration): 1\n\n' +
        'Name "Bench Press", calories per hour 400 and modality weight_reps are copied onto each entry.\n\n' +
        'Confirm with the user first. If they agree, call sync_exercise_entries again with the same fields and confirmed=true. Nothing was changed.'
    );
    expectNoWrites();
  });

  it('leaves calories alone unless recompute_calories is set', async () => {
    givenOwnedExercise();
    vi.mocked(getExerciseEntrySyncPreview).mockResolvedValue({
      ...SUMMARY,
      recomputed_count: 0,
      calories_after: 900,
    });

    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
    });

    expect(getExerciseEntrySyncPreview).toHaveBeenCalledWith(
      USER,
      EX_ID,
      300,
      false
    );
    expect(result).toContain(
      '- Calories burned are not recomputed (recompute_calories is off).'
    );
    expectNoWrites();
  });

  it('writes the snapshot when confirmed', async () => {
    givenOwnedExercise();
    vi.mocked(getExerciseEntrySyncPreview).mockResolvedValue(SUMMARY);
    vi.mocked(syncExerciseEntriesWithExercise).mockResolvedValue(SUMMARY);

    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
      recompute_calories: true,
      confirmed: true,
    });

    expect(syncExerciseEntriesWithExercise).toHaveBeenCalledWith(
      USER,
      EX_ID,
      {
        exercise_name: 'Bench Press',
        calories_per_hour: 300,
        modality: 'weight_reps',
      },
      true
    );
    expect(result).toMatch(/^✅ Diary entries synced with "Bench Press"/);
    expect(result).toContain('- Calorie total: 900 kcal → 1150.4 kcal');
    expect(exerciseService.updateExercise).not.toHaveBeenCalled();
  });

  it('allows a visible exercise the user does not own, since only their own entries change', async () => {
    vi.mocked(exerciseService.getExerciseById).mockResolvedValue({
      ...OWNED_ROW,
      user_id: null,
    });
    vi.mocked(getExerciseEntrySyncPreview).mockResolvedValue(SUMMARY);

    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
    });

    expect(result).toContain('Preview of syncing diary entries');
    expect(exerciseDb.getExerciseOwnerId).not.toHaveBeenCalled();
  });

  it('refuses to recompute without calories_per_hour', async () => {
    givenOwnedExercise({ ...OWNED_ROW, calories_per_hour: null });
    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
      recompute_calories: true,
      confirmed: true,
    });
    expect(result).toMatch(
      /^Error \[VALIDATION\]: "Bench Press" has no calories_per_hour/
    );
    expect(getExerciseEntrySyncPreview).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('says so when no entries use the exercise', async () => {
    givenOwnedExercise();
    vi.mocked(getExerciseEntrySyncPreview).mockResolvedValue({
      ...SUMMARY,
      entry_count: 0,
    });
    const result = await run({
      action: 'sync_exercise_entries',
      exercise_id: EX_ID,
      confirmed: true,
    });
    expect(result).toBe(
      'No diary entries use "Bench Press". Nothing was changed.'
    );
    expectNoWrites();
  });
});

describe('add_exercise_image', () => {
  it.each([
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/a.png',
    'http://10.0.0.1/a.png',
  ])('refuses the private address %s before anything else', async (url) => {
    givenOwnedExercise();
    const result = await run({
      action: 'add_exercise_image',
      exercise_id: EX_ID,
      url,
      confirmed: true,
    });
    expect(result).toBe(
      'Error [VALIDATION]: The URL points to a private or internal network address, which is not allowed.'
    );
    expectNoWrites();
  });

  it.each(['file:///etc/passwd', 'ftp://cdn.example.com/a.png', 'not a url'])(
    'refuses the non-http URL %s',
    async (url) => {
      const result = await run({
        action: 'add_exercise_image',
        exercise_id: EX_ID,
        url,
        confirmed: true,
      });
      expect(result).toBe(
        'Error [VALIDATION]: url must be a public http or https address without credentials or a #fragment.'
      );
      expectNoWrites();
    }
  );

  it('previews without downloading when not confirmed', async () => {
    givenOwnedExercise();
    const result = await run({
      action: 'add_exercise_image',
      exercise_id: EX_ID,
      url: 'https://cdn.example.com/bench.png',
    });
    expect(result).toBe(
      `Preview: the image at https://cdn.example.com/bench.png will be downloaded (PNG, JPEG, GIF or WebP, up to 10 MB) and added to "Bench Press" (ID: ${EX_ID}) as image index 2.\n\n` +
        'Confirm with the user first. If they agree, call add_exercise_image again with the same fields and confirmed=true. Nothing was downloaded or changed.'
    );
    expectNoWrites();
  });

  it('refuses an exercise the user does not own without downloading', async () => {
    vi.mocked(exerciseService.getExerciseById).mockResolvedValue({
      ...OWNED_ROW,
      user_id: 'someone-else',
    });
    vi.mocked(exerciseDb.getExerciseOwnerId).mockResolvedValue('someone-else');
    const result = await run({
      action: 'add_exercise_image',
      exercise_id: EX_ID,
      url: 'https://cdn.example.com/bench.png',
      confirmed: true,
    });
    expect(result).toMatch(/^Error \[FORBIDDEN\]: "Bench Press" is shared/);
    expectNoWrites();
  });

  it('downloads and appends the image when confirmed', async () => {
    givenOwnedExercise();
    vi.mocked(downloadUserSuppliedImage).mockResolvedValue(IMAGE_PATH);
    vi.mocked(appendExerciseImage).mockResolvedValue({
      images: [...OWNED_ROW.images, IMAGE_PATH],
      index: 2,
    });

    const result = await run({
      action: 'add_exercise_image',
      exercise_id: EX_ID,
      url: 'https://cdn.example.com/bench.png',
      confirmed: true,
    });

    expect(downloadUserSuppliedImage).toHaveBeenCalledWith(
      'https://cdn.example.com/bench.png',
      EX_ID,
      'exercises'
    );
    expect(appendExerciseImage).toHaveBeenCalledWith(USER, EX_ID, IMAGE_PATH);
    expect(result).toBe(
      `✅ Image added to "Bench Press" as index 2: ${IMAGE_PATH}`
    );
  });

  it.each([
    [
      // What fetch throws when the guarded lookup refuses a DNS answer
      // (e.g. a redirect to a host that resolves to 10.x).
      new TypeError('fetch failed', {
        cause: new OutboundUrlBlockedError('private'),
      }),
      'The URL points to a private or internal network address, which is not allowed.',
    ],
    [
      new Error(
        '[imageDownloader] Image exceeds maximum size of 10485760 bytes'
      ),
      'The image is larger than the 10 MB limit.',
    ],
    [
      new Error(
        '[imageDownloader] Rejected image with disallowed content-type: text/html'
      ),
      'The URL did not return a PNG, JPEG, GIF or WebP image.',
    ],
    [
      new Error(
        '[imageDownloader] Image content does not match its content-type image/png (detected unknown)'
      ),
      'The URL did not return a PNG, JPEG, GIF or WebP image.',
    ],
    [
      new Error('[imageDownloader] Image exceeded the 5-redirect limit'),
      'The URL redirected too many times or without a destination.',
    ],
    [
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError'
      ),
      'The image server took too long to respond.',
    ],
  ])(
    'reports a download failure (%s) and saves no reference',
    async (error, reason) => {
      givenOwnedExercise();
      vi.mocked(downloadUserSuppliedImage).mockRejectedValue(error);

      const result = await run({
        action: 'add_exercise_image',
        exercise_id: EX_ID,
        url: 'https://cdn.example.com/bench.png',
        confirmed: true,
      });

      expect(result).toBe(
        `Error [VALIDATION]: Could not add the image: ${reason} Nothing was changed.`
      );
      expect(appendExerciseImage).not.toHaveBeenCalled();
    }
  );

  it('removes the downloaded file when the reference cannot be saved', async () => {
    givenOwnedExercise();
    vi.mocked(downloadUserSuppliedImage).mockResolvedValue(IMAGE_PATH);
    vi.mocked(appendExerciseImage).mockResolvedValue(null);
    const unlink = vi.spyOn(fsp, 'unlink').mockResolvedValue(undefined);

    const result = await run({
      action: 'add_exercise_image',
      exercise_id: EX_ID,
      url: 'https://cdn.example.com/bench.png',
      confirmed: true,
    });

    expect(result).toBe(
      'Error [FORBIDDEN]: "Bench Press" is no longer an exercise you own. Nothing was changed.'
    );
    expect(unlink).toHaveBeenCalledWith(
      path.join(UPLOADS_BASE_DIR, 'exercises', EX_ID, path.basename(IMAGE_PATH))
    );
  });
});

describe('remove_exercise_image', () => {
  it('previews by index without writing', async () => {
    givenOwnedExercise();
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      index: 1,
    });
    expect(result).toBe(
      `Preview: image [1] /uploads/exercises/b.png will be removed from "Bench Press" (ID: ${EX_ID}). Only the reference is removed; the file stays on the server.\n\n` +
        'Confirm with the user first. If they agree, call remove_exercise_image again with the same fields and confirmed=true. Nothing was changed.'
    );
    expectNoWrites();
  });

  it('unlinks the reference by path when confirmed and keeps the file', async () => {
    givenOwnedExercise();
    vi.mocked(removeExerciseImage).mockResolvedValue({
      images: ['/uploads/exercises/b.png'],
      removed: '/uploads/exercises/a.png',
      index: 0,
    });
    const unlink = vi.spyOn(fsp, 'unlink');

    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      path: '/uploads/exercises/a.png',
      confirmed: true,
    });

    expect(removeExerciseImage).toHaveBeenCalledWith(USER, EX_ID, {
      index: 0,
      imagePath: '/uploads/exercises/a.png',
    });
    expect(result).toBe(
      '✅ Image [0] /uploads/exercises/a.png removed from "Bench Press". 1 image(s) remain; the file was kept.'
    );
    expect(unlink).not.toHaveBeenCalled();
  });

  it('refuses when index and path disagree', async () => {
    givenOwnedExercise();
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      index: 0,
      path: '/uploads/exercises/b.png',
      confirmed: true,
    });
    expect(result).toBe(
      'Error [VALIDATION]: No image on "Bench Press" matches index 0 and path /uploads/exercises/b.png. Current images:\n' +
        '- [0] /uploads/exercises/a.png\n' +
        '- [1] /uploads/exercises/b.png'
    );
    expectNoWrites();
  });

  it('refuses an out-of-range index', async () => {
    givenOwnedExercise();
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      index: 5,
      confirmed: true,
    });
    expect(result).toMatch(
      /^Error \[VALIDATION\]: No image on "Bench Press" matches index 5\./
    );
    expectNoWrites();
  });

  it('requires a path or an index', async () => {
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      confirmed: true,
    });
    expect(result).toBe(
      'Error [VALIDATION]: path: Either path or index must be provided'
    );
    expectNoWrites();
  });

  it('changes nothing when the list moved since the preview', async () => {
    givenOwnedExercise();
    vi.mocked(removeExerciseImage).mockResolvedValue(null);
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      index: 1,
      confirmed: true,
    });
    expect(result).toBe(
      'Error [VALIDATION]: The images on "Bench Press" changed in the meantime. Call get_exercise_details again to see the current list. Nothing was changed.'
    );
  });

  it('refuses an exercise the user does not own', async () => {
    vi.mocked(exerciseService.getExerciseById).mockResolvedValue({
      ...OWNED_ROW,
      user_id: null,
    });
    vi.mocked(exerciseDb.getExerciseOwnerId).mockResolvedValue(null);
    const result = await run({
      action: 'remove_exercise_image',
      exercise_id: EX_ID,
      index: 0,
      confirmed: true,
    });
    expect(result).toMatch(
      /^Error \[FORBIDDEN\]: "Bench Press" is a built-in System exercise/
    );
    expectNoWrites();
  });
});

describe('get_exercise_details images', () => {
  it('lists each image with its index and path', async () => {
    vi.mocked(exerciseService.getExerciseById).mockResolvedValue({
      ...OWNED_ROW,
      instructions: null,
    });
    const result = await run({
      action: 'get_exercise_details',
      exercise_id: EX_ID,
    });
    expect(result).toContain(
      '#### Images (index: path)\n' +
        '- [0] /uploads/exercises/a.png\n' +
        '- [1] /uploads/exercises/b.png\n'
    );
  });
});
