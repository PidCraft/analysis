import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { LiveViewResponse, ViewTick } from '../types/youtube';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

//Blueprint Synchronicity Constants (matching firebase-blueprint.json & firestore.rules)
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const MAX_TITLE_LEN = 300;
const MAX_CHANNEL_LEN = 150;
const MAX_PUBLISHED_ISO_LEN = 64;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection on boot per Firebase Integration Skill
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export function subscribeAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGooglePopup(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function buildVideoDocId(uid: string, videoId: string): string {
  const docId = `${uid}_${videoId}`;
  if (!ID_REGEX.test(docId) || docId.length > 128 || !VIDEO_ID_REGEX.test(videoId)) {
    throw new Error('Format ID dokumen tidak valid.');
  }
  return docId;
}

export function buildTickId(epochMs: number): string {
  // Bucket to 1-second resolution so ticks are deterministic and idempotent
  const sec = Math.floor(epochMs / 1000);
  return `t_${sec}`;
}

export async function loadCloudTicksForVideo(
  uid: string,
  videoId: string
): Promise<{ ticks: ViewTick[]; syncedTickIds: Set<string> }> {
  const docId = buildVideoDocId(uid, videoId);
  const ticksPath = `videos/${docId}/ticks`;

  try {
    const q = query(
      collection(db, 'videos', docId, 'ticks'),
      where('ownerId', '==', uid),
      orderBy('epochMs', 'asc'),
      limit(1500)
    );
    const snap = await getDocs(q);
    const ticks: ViewTick[] = [];
    const syncedTickIds = new Set<string>();

    snap.forEach((d) => {
      syncedTickIds.add(d.id);
      const item = d.data();
      if (typeof item.epochMs === 'number' && typeof item.views === 'number') {
        ticks.push({
          epochMs: item.epochMs,
          timestamp: new Date(item.epochMs).toISOString(),
          views: item.views,
        });
      }
    });

    return { ticks, syncedTickIds };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, ticksPath);
  }
}

export async function ensureParentWatchedVideoDoc(
  uid: string,
  data: LiveViewResponse
): Promise<string> {
  const docId = buildVideoDocId(uid, data.videoId);
  const docPath = `videos/${docId}`;
  const videoRef = doc(db, 'videos', docId);

  const safeTitle = (data.title || data.videoId).slice(0, MAX_TITLE_LEN);
  const safeChannel = (data.channelName || 'YouTube').slice(0, MAX_CHANNEL_LEN);
  const safePublished = (data.publishedAt || '').slice(0, MAX_PUBLISHED_ISO_LEN);
  const safeViews = Math.max(0, Math.min(1_000_000_000_000, Math.round(data.views)));

  let exists = false;
  try {
    const snap = await getDoc(videoRef);
    exists = snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }

  try {
    if (!exists) {
      await setDoc(videoRef, {
        ownerId: uid,
        videoId: data.videoId,
        title: safeTitle,
        channelName: safeChannel,
        publishedAtIso: safePublished,
        latestViews: safeViews,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        videoRef,
        {
          title: safeTitle,
          channelName: safeChannel,
          publishedAtIso: safePublished,
          latestViews: safeViews,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
    return docId;
  } catch (error) {
    handleFirestoreError(
      error,
      exists ? OperationType.UPDATE : OperationType.CREATE,
      docPath
    );
  }
}

/**
 * Compacts ticks for Cloud Firestore persistence: stores every point where `views` changed,
 * plus periodic heartbeat anchor points (at least 1 per 60 seconds) so curves remain accurate
 * while conserving daily free-tier Firestore write quota!
 */
export function selectSignificantCloudTicks(
  allTicks: ViewTick[],
  syncedTickIds: Set<string>
): ViewTick[] {
  const unsynced: ViewTick[] = [];
  let lastKeptViews: number | null = null;
  let lastKeptEpoch = 0;

  for (let i = 0; i < allTicks.length; i++) {
    const t = allTicks[i];
    const isFirst = i === 0;
    const isLast = i === allTicks.length - 1;
    const viewsChanged = lastKeptViews === null || t.views !== lastKeptViews;
    const heartbeatDue = t.epochMs - lastKeptEpoch >= 60_000;

    if (isFirst || isLast || viewsChanged || heartbeatDue) {
      lastKeptViews = t.views;
      lastKeptEpoch = t.epochMs;
      const tickId = buildTickId(t.epochMs);
      if (!syncedTickIds.has(tickId)) {
        unsynced.push(t);
      }
    }
  }
  return unsynced;
}

export async function syncUnsyncedTicksToCloud(
  uid: string,
  videoId: string,
  docId: string,
  unsyncedTicks: ViewTick[],
  syncedTickIds: Set<string>
): Promise<number> {
  if (unsyncedTicks.length === 0) return 0;

  // Firestore batch max is 500 writes; write in chunks of 250
  const chunks: ViewTick[][] = [];
  for (let i = 0; i < unsyncedTicks.length; i += 250) {
    chunks.push(unsyncedTicks.slice(i, i + 250));
  }

  let written = 0;
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    const seenInBatch = new Set<string>();

    for (const t of chunk) {
      const tickId = buildTickId(t.epochMs);
      if (syncedTickIds.has(tickId) || seenInBatch.has(tickId)) continue;
      if (t.epochMs < 1_000_000_000_000 || t.epochMs > 9_999_999_999_999) continue;

      seenInBatch.add(tickId);
      const tickRef = doc(db, 'videos', docId, 'ticks', tickId);
      batch.set(tickRef, {
        ownerId: uid,
        videoId,
        epochMs: Math.round(t.epochMs),
        views: Math.max(0, Math.min(1_000_000_000_000, Math.round(t.views))),
        createdAt: serverTimestamp(),
      });
    }

    if (seenInBatch.size > 0) {
      try {
        await batch.commit();
        for (const id of seenInBatch) {
          syncedTickIds.add(id);
        }
        written += seenInBatch.size;
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `videos/${docId}/ticks`);
      }
    }
  }

  return written;
}

export async function clearCloudTicksForVideo(
  uid: string,
  videoId: string,
  syncedTickIds: Set<string>
): Promise<void> {
  const docId = buildVideoDocId(uid, videoId);
  const ticksPath = `videos/${docId}/ticks`;

  try {
    const q = query(
      collection(db, 'videos', docId, 'ticks'),
      where('ownerId', '==', uid),
      limit(450)
    );
    const snap = await getDocs(q);
    if (snap.empty) return;

    const batch = writeBatch(db);
    snap.forEach((d) => {
      batch.delete(d.ref);
    });
    await batch.commit();
    syncedTickIds.clear();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, ticksPath);
  }
}
