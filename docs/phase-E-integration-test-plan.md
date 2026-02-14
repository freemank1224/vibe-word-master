# Phase E Integration Test Plan
## Multi-Device Data Consistency Verification

### Test Scenarios

#### Scenario 1: Sequential Login (Baseline)
**Purpose**: Verify data loads correctly on single device

1. **Device A**: Login
2. **Verify**: Daily stats load from database
3. **Expected**: Stats display correctly with version numbers

#### Scenario 2: Concurrent Test Sessions (Conflict Detection)
**Purpose**: Verify version conflict detection and auto-merge

1. **Device A**: Login → Test 10 words (6 correct) → Complete
2. **Device B** (simulated): Login immediately after → Test 10 words (9 correct) → Complete
3. **Database**: Receives both updates, records conflict, auto-merges
4. **Device A**: Refresh page or trigger stats reload
5. **Expected**:
   - Conflict warning in console
   - Stats show merged values (total=20, correct=15)
   - UI notification: "版本冲突已自动解决"

#### Scenario 3: Login After Conflict (Data Consistency)
**Purpose**: Verify both devices see consistent data

1. **Device A**: Already logged in, has stats (total=20, correct=15)
2. **Device B**: Login for first time
3. **Expected**:
   - Device B loads same data as Device A
   - Both see: total=20, correct=15
   - No conflict detected (versions match)

#### Scenario 4: Offline Test Then Sync
**Purpose**: Verify offline queue doesn't interfere with version control

1. **Device A**: Enable airplane mode
2. **Test**: Complete 10 words (7 correct)
3. **Verify**: Data saved in offline queue
4. **Disable airplane mode** → Auto-sync
5. **Expected**:
   - Data synced to database
   - Stats updated with new version
   - No data loss

### Manual Testing Steps

#### Using Supabase Dashboard
1. Open Supabase Dashboard → Table Editor
2. Query `daily_stats` table
3. Verify columns exist:
   - `version` (BIGINT)
   - `updated_at` (TIMESTAMPTZ)
4. Check data after concurrent tests:
   ```sql
   SELECT date, version, total_count, correct_count
   FROM daily_stats
   WHERE user_id = 'your-user-id'
   ORDER BY date DESC, version DESC;
   ```

#### Using Browser Console
1. Open App in browser
2. Open DevTools Console
3. Filter for: `[resolveStatsUpdate]` or `[updateLocalStats]`
4. Watch for conflict warnings:
   - `⚠️ Version conflict detected`
   - `✅ Merged stats for 2025-02-13`

### Verification Checklist
- [ ] Scenario 1: Single device login works
- [ ] Scenario 2: Conflict detected and merged
- [ ] Scenario 3: Multi-device shows same data
- [ ] Scenario 4: Offline queue sync works
- [ ] Database has `version` column
- [ ] Database has `updated_at` column
- [ ] Conflict warnings appear in console
- [ ] UI notification shows for conflicts
- [ ] No data loss in any scenario
