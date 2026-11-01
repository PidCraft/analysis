/**
 * Adversarial Security Specification Test Suite ("Dirty Dozen" Payloads)
 * Verifies every invariant in security_spec.md against the Firestore ruleset logic.
 */

interface AuthContext {
  uid: string;
  emailVerified: boolean;
}

interface SimulatedRequest {
  auth: AuthContext | null;
  timeMs: number;
  path: string;
  op: 'get' | 'list' | 'create' | 'update' | 'delete';
  resourceData?: Record<string, unknown>;
  existingData?: Record<string, unknown>;
  parentData?: Record<string, unknown> | null;
}

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_REGEX.test(id);
}

function isValidWatchedVideo(data: Record<string, unknown>, authUid: string): boolean {
  const allowed = [
    'ownerId',
    'videoId',
    'title',
    'channelName',
    'publishedAtIso',
    'latestViews',
    'createdAt',
    'updatedAt',
  ];
  const keys = Object.keys(data);
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) {
    return false;
  }
  return (
    typeof data.ownerId === 'string' &&
    data.ownerId.length >= 1 &&
    data.ownerId.length <= 128 &&
    ID_REGEX.test(data.ownerId) &&
    data.ownerId === authUid &&
    typeof data.videoId === 'string' &&
    data.videoId.length === 11 &&
    VIDEO_ID_REGEX.test(data.videoId) &&
    typeof data.title === 'string' &&
    data.title.length >= 1 &&
    data.title.length <= 300 &&
    typeof data.channelName === 'string' &&
    data.channelName.length >= 1 &&
    data.channelName.length <= 150 &&
    typeof data.publishedAtIso === 'string' &&
    data.publishedAtIso.length <= 64 &&
    typeof data.latestViews === 'number' &&
    Number.isInteger(data.latestViews) &&
    data.latestViews >= 0 &&
    data.latestViews <= 1_000_000_000_000
  );
}

function isValidViewTick(data: Record<string, unknown>, authUid: string): boolean {
  const allowed = ['ownerId', 'videoId', 'epochMs', 'views', 'createdAt'];
  const keys = Object.keys(data);
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) {
    return false;
  }
  return (
    typeof data.ownerId === 'string' &&
    data.ownerId.length >= 1 &&
    data.ownerId.length <= 128 &&
    ID_REGEX.test(data.ownerId) &&
    data.ownerId === authUid &&
    typeof data.videoId === 'string' &&
    data.videoId.length === 11 &&
    VIDEO_ID_REGEX.test(data.videoId) &&
    typeof data.epochMs === 'number' &&
    Number.isInteger(data.epochMs) &&
    data.epochMs >= 1_000_000_000_000 &&
    data.epochMs <= 9_999_999_999_999 &&
    typeof data.views === 'number' &&
    Number.isInteger(data.views) &&
    data.views >= 0 &&
    data.views <= 1_000_000_000_000
  );
}

export function evaluateRule(req: SimulatedRequest): 'ALLOW' | 'PERMISSION_DENIED' {
  if (!req.auth || !req.auth.emailVerified) return 'PERMISSION_DENIED';
  const segments = req.path.split('/').filter(Boolean);

  // /videos/{docId}
  if (segments.length === 2 && segments[0] === 'videos') {
    const docId = segments[1];
    if (req.op === 'list') {
      return req.existingData?.ownerId === req.auth.uid ? 'ALLOW' : 'PERMISSION_DENIED';
    }
    if (!isValidId(docId)) return 'PERMISSION_DENIED';
    if (req.op === 'get' || req.op === 'delete') {
      return req.existingData?.ownerId === req.auth.uid ? 'ALLOW' : 'PERMISSION_DENIED';
    }
    if (req.op === 'create' && req.resourceData) {
      if (
        isValidWatchedVideo(req.resourceData, req.auth.uid) &&
        req.resourceData.createdAt === req.timeMs &&
        req.resourceData.updatedAt === req.timeMs
      ) {
        return 'ALLOW';
      }
      return 'PERMISSION_DENIED';
    }
    if (req.op === 'update' && req.resourceData && req.existingData) {
      if (!isValidWatchedVideo(req.resourceData, req.auth.uid)) return 'PERMISSION_DENIED';
      if (req.existingData.ownerId !== req.auth.uid) return 'PERMISSION_DENIED';
      if (
        req.resourceData.ownerId !== req.existingData.ownerId ||
        req.resourceData.videoId !== req.existingData.videoId ||
        req.resourceData.createdAt !== req.existingData.createdAt ||
        req.resourceData.updatedAt !== req.timeMs
      ) {
        return 'PERMISSION_DENIED';
      }
      return 'ALLOW';
    }
  }

  // /videos/{docId}/ticks/{tickId}
  if (segments.length === 4 && segments[0] === 'videos' && segments[2] === 'ticks') {
    const [, docId, , tickId] = segments;
    if (req.op === 'list') {
      return req.existingData?.ownerId === req.auth.uid ? 'ALLOW' : 'PERMISSION_DENIED';
    }
    if (!isValidId(docId) || !isValidId(tickId)) return 'PERMISSION_DENIED';
    if (!req.parentData || req.parentData.ownerId !== req.auth.uid) return 'PERMISSION_DENIED';

    if (req.op === 'get' || req.op === 'delete') {
      return req.existingData?.ownerId === req.auth.uid ? 'ALLOW' : 'PERMISSION_DENIED';
    }
    if (req.op === 'create' && req.resourceData) {
      if (
        isValidViewTick(req.resourceData, req.auth.uid) &&
        req.resourceData.createdAt === req.timeMs &&
        req.resourceData.videoId === req.parentData.videoId
      ) {
        return 'ALLOW';
      }
      return 'PERMISSION_DENIED';
    }
    if (req.op === 'update') {
      return 'PERMISSION_DENIED';
    }
  }

  return 'PERMISSION_DENIED';
}

export function runDirtyDozenSuite(): void {
  const now = 1793530000000;
  const baseVideo = {
    ownerId: 'user_1',
    videoId: 'u3vex1jIlAM',
    title: 'GTPS Terbaru 2026',
    channelName: 'Zoro GTPS',
    publishedAtIso: '2026-11-01T10:14:18Z',
    latestViews: 9,
    createdAt: now,
    updatedAt: now,
  };

  const dirtyDozen: { name: string; req: SimulatedRequest }[] = [
    {
      name: '1. Unauthenticated Write',
      req: { auth: null, timeMs: now, path: '/videos/user_1_u3vex1jIlAM', op: 'create', resourceData: baseVideo },
    },
    {
      name: '2. Unverified Email Spoof',
      req: {
        auth: { uid: 'user_1', emailVerified: false },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'create',
        resourceData: baseVideo,
      },
    },
    {
      name: '3. Identity Spoofing on Create',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: '/videos/user_2_u3vex1jIlAM',
        op: 'create',
        resourceData: { ...baseVideo, ownerId: 'user_2' },
      },
    },
    {
      name: '4. Shadow Ghost Field Injection on Create',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'create',
        resourceData: { ...baseVideo, isAdmin: true },
      },
    },
    {
      name: '5. Shadow Ghost Field Injection on Update',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now + 1000,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'update',
        existingData: baseVideo,
        resourceData: { ...baseVideo, updatedAt: now + 1000, ghostField: 'bad' },
      },
    },
    {
      name: '6. Immutable Field Mutation (videoId changed)',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now + 1000,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'update',
        existingData: baseVideo,
        resourceData: { ...baseVideo, videoId: 'dQw4w9WgXcQ', updatedAt: now + 1000 },
      },
    },
    {
      name: '7. Forged Client Timestamp',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'create',
        resourceData: { ...baseVideo, createdAt: now - 50000 },
      },
    },
    {
      name: '8. Path ID Poisoning (>128 chars)',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: `/videos/${'a'.repeat(140)}`,
        op: 'create',
        resourceData: baseVideo,
      },
    },
    {
      name: '9. Value Poisoning (Negative Views)',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM',
        op: 'create',
        resourceData: { ...baseVideo, latestViews: -5 },
      },
    },
    {
      name: '10. Orphaned Subcollection Tick Write',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM/ticks/t_1',
        op: 'create',
        parentData: null,
        resourceData: {
          ownerId: 'user_1',
          videoId: 'u3vex1jIlAM',
          epochMs: now,
          views: 9,
          createdAt: now,
        },
      },
    },
    {
      name: '11. Cross-Tenant Subcollection Read',
      req: {
        auth: { uid: 'attacker', emailVerified: true },
        timeMs: now,
        path: '/videos/user_1_u3vex1jIlAM/ticks/t_1',
        op: 'get',
        parentData: baseVideo,
        existingData: {
          ownerId: 'user_1',
          videoId: 'u3vex1jIlAM',
          epochMs: now,
          views: 9,
          createdAt: now,
        },
      },
    },
    {
      name: '12. Unauthorized Tick History Mutation (Update Forbidden)',
      req: {
        auth: { uid: 'user_1', emailVerified: true },
        timeMs: now + 1000,
        path: '/videos/user_1_u3vex1jIlAM/ticks/t_1',
        op: 'update',
        parentData: baseVideo,
        existingData: {
          ownerId: 'user_1',
          videoId: 'u3vex1jIlAM',
          epochMs: now,
          views: 9,
          createdAt: now,
        },
        resourceData: {
          ownerId: 'user_1',
          videoId: 'u3vex1jIlAM',
          epochMs: now,
          views: 99999,
          createdAt: now,
        },
      },
    },
  ];

  for (const testCase of dirtyDozen) {
    const res = evaluateRule(testCase.req);
    if (res !== 'PERMISSION_DENIED') {
      throw new Error(`SECURITY FAILURE on ${testCase.name}: expected PERMISSION_DENIED, got ${res}`);
    }
  }
}

runDirtyDozenSuite();
