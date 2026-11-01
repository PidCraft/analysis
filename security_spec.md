# Security Specification — PantauView Firestore Rules

## 1. Data Invariants

1. **Default-Deny Catch-All**: Seluruh path di luar `/videos/{docId}` dan `/videos/{docId}/ticks/{tickId}` ditolak secara eksplisit (`allow read, write: if false;`).
2. **Verified Identity Gate**: Semua pembacaan dan penulisan wajib dilakukan oleh pengguna terautentikasi dengan email terverifikasi (`request.auth != null && request.auth.token.email_verified == true`).
3. **Zero PII Storage**: Tidak ada alamat email, nomor telepon, atau alamat fisik yang disimpan di dokumen Firestore mana pun.
4. **Master Gate Relational Integrity**: Subkoleksi `/videos/{docId}/ticks/{tickId}` hanya dapat dibaca (`get`), dibuat (`create`), atau dihapus (`delete`) jika dokumen induk `/videos/{docId}` benar-benar ada dan `ownerId`-nya sama persis dengan `request.auth.uid`, serta `videoId` pada tick cocok dengan `videoId` induk.
5. **Immutable Append-Only Ticks**: Dokumen `ticks` bersifat *append-only* (`allow update: if false;`), sehingga riwayat tayangan historis tidak dapat dimanipulasi setelah tercatat.
6. **Strict Schema, Key Allowlist & Temporal Integrity**:
   - Semua ID path (`docId`, `tickId`) dibatasi `<= 128` karakter alfanumerik `^[a-zA-Z0-9_\-]+$`.
   - `createdAt` dan `updatedAt` wajib sama persis dengan `request.time`.
   - Pada `update` dokumen `/videos/{docId}`, field `ownerId`, `videoId`, dan `createdAt` bersifat *immutable*, dan `affectedKeys().hasOnly(...)` membatasi hanya field metadata terbaru (`title`, `channelName`, `publishedAtIso`, `latestViews`, `updatedAt`).
7. **Query Enforcer pada List**: `allow list` pada `/videos` maupun `/videos/{docId}/ticks` memvalidasi `resource.data.ownerId == request.auth.uid` secara langsung tanpa `get()` berbiaya O(n).

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unauthenticated Write**: `auth = null` mencoba menulis `/videos/u1_u3vex1jIlAM` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `auth = { uid: 'u1', token: { email_verified: false } }` mencoba membaca atau menulis -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: `auth.uid = 'u1'` mengirim `ownerId: 'u2'` pada `/videos/u2_u3vex1jIlAM` -> `PERMISSION_DENIED`.
4. **Shadow Ghost Field Injection on Create**: Payload menyertakan field tambahan `isAdmin: true` di luar `hasOnly(...)` -> `PERMISSION_DENIED`.
5. **Shadow Ghost Field Injection on Update**: Update pada `/videos/u1_u3vex1jIlAM` menyertakan field tidak dikenal `hacked: 1` -> `PERMISSION_DENIED`.
6. **Immutable Field Mutation**: Update mencoba mengubah `ownerId`, `videoId`, atau `createdAt` pada `/videos/u1_u3vex1jIlAM` -> `PERMISSION_DENIED`.
7. **Forged Client Timestamp**: Create mengirim `createdAt` masa lalu (bukan `request.time`) -> `PERMISSION_DENIED`.
8. **Path ID Poisoning (Denial of Wallet)**: `docId` berisi karakter ilegal atau panjang > 128 karakter -> `PERMISSION_DENIED`.
9. **Value Poisoning (Oversized String / Negative Views)**: `title` sepanjang 5.000 karakter atau `latestViews: -50` -> `PERMISSION_DENIED`.
10. **Orphaned Subcollection Tick Write**: Menulis `/videos/nonexistent/ticks/t_1` tanpa dokumen induk `/videos/nonexistent` -> `PERMISSION_DENIED`.
11. **Cross-Tenant Subcollection Read/Write**: `auth.uid = 'attacker'` mencoba membuat atau membaca tick di bawah `/videos/victim_u3vex1jIlAM/ticks/t_1` -> `PERMISSION_DENIED`.
12. **Blanket Unfiltered List Scraping**: `auth.uid = 'attacker'` menjalankan query `list` tanpa filter `where('ownerId', '==', 'attacker')` -> `PERMISSION_DENIED`.
