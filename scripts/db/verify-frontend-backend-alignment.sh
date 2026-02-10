#!/bin/bash

# ================================================================
# Frontend-Backend Alignment Verification Script
# ================================================================
# This script checks if the frontend TypeScript interfaces match
# the actual database schema
# ================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 Frontend-Backend Alignment Check${NC}"
echo "================================================"
echo ""

# Load environment
if [ -f .env ]; then
    source .env
else
    echo -e "${RED}❌ .env file not found!${NC}"
    exit 1
fi

# Extract project ID from SUPABASE_URL
# URL format: https://mkdxdlsjisqazermmfoe.supabase.co
PROJECT_REF=$(echo $SUPABASE_URL | sed -E 's|https://([^.]+)\.supabase\.co|\1|')

echo -e "${YELLOW}📊 Project: ${PROJECT_REF}${NC}"
echo ""

# Check types.ts
echo -e "${BLUE}1. Checking TypeScript interfaces...${NC}"

if [ ! -f "types.ts" ]; then
    echo -e "${RED}❌ types.ts not found!${NC}"
    exit 1
fi

echo -e "${GREEN}✓ types.ts found${NC}"

# Extract interface fields (simple grep)
echo ""
echo -e "${BLUE}Key interfaces in types.ts:${NC}"
grep -A 20 "^export interface WordEntry" types.ts | grep "^\s*[a-zA-Z]" | head -10
echo "  ..."
grep -A 10 "^export interface InputSession" types.ts | grep "^\s*[a-zA-Z]" | head -8

echo ""
echo -e "${BLUE}2. Expected Database Schema (from baseline):${NC}"

# Read baseline schema
BASELINE="database/snapshot/20250210_baseline_schema.sql"

if [ ! -f "$BASELINE" ]; then
    echo -e "${RED}❌ Baseline schema not found!${NC}"
    echo "Run: ./scripts/init-db-version-control.sh"
    exit 1
fi

echo -e "${GREEN}✓ Baseline schema found${NC}"

# Extract key column definitions
echo ""
echo -e "${YELLOW}words table key columns:${NC}"
grep -A 50 "CREATE TABLE IF NOT EXISTS public.words" "$BASELINE" | grep "^\s*[a-zA-Z_]\+ " | head -15

echo ""
echo -e "${YELLOW}sessions table key columns:${NC}"
grep -A 25 "CREATE TABLE IF NOT EXISTS public.sessions" "$BASELINE" | grep "^\s*[a-zA-Z_]\+ " | head -10

echo ""
echo -e "${BLUE}3. Field Mapping Check:${NC}"
echo ""

# Check for critical fields
echo "Critical fields check:"

declare -a critical_fields=(
    "words:id"
    "words:text"
    "words:user_id"
    "words:session_id"
    "words:correct"
    "words:tested"
    "words:last_tested"
    "words:error_count"
    "words:score"
    "words:tags"
    "words:deleted"
    "sessions:id"
    "sessions:user_id"
    "sessions:library_tag"
    "sessions:word_count"
    "sessions:deleted"
)

all_good=true

for field in "${critical_fields[@]}"; do
    table=$(echo $field | cut -d: -f1)
    column=$(echo $field | cut -d: -f2)

    # Check if column exists in baseline
    if grep -q "CREATE TABLE.*public.${table}" "$BASELINE"; then
        if grep -A 100 "CREATE TABLE.*public.${table}" "$BASELINE" | grep -q "^\s*${column} "; then
            echo -e "${GREEN}  ✓ ${table}.${column}${NC}"
        else
            echo -e "${RED}  ✗ ${table}.${column} MISSING in schema${NC}"
            all_good=false
        fi
    fi
done

echo ""
echo -e "${BLUE}4. TypeScript vs Database Naming Convention:${NC}"
echo ""

# Check for camelCase (TypeScript) vs snake_case (database)
echo "Checking for common naming mismatches:"

# Common conversions
declare -a conversions=(
    "user_id:userId"
    "session_id:sessionId"
    "word_count:wordCount"
    "target_count:targetCount"
    "image_path:imagePath"
    "audio_url:audioUrl"
    "definition_en:definitionEn"
    "definition_cn:definitionCn"
    "error_count:errorCount"
    "best_time_ms:bestTimeMs"
    "last_tested:lastTested"
    "library_tag:libraryTag"
    "created_at:createdAt"
    "updated_at:updatedAt"
    "deleted_at:deletedAt"
)

for conversion in "${conversions[@]}"; do
    snake=$(echo $conversion | cut -d: -f1)
    camel=$(echo $conversion | cut -d: -f2)

    # Check if TypeScript uses camelCase
    if grep -q "$camel" types.ts; then
        echo -e "${GREEN}  ✓ $snake → $camel${NC}"
    else
        echo -e "${YELLOW}  ⚠ $snake → $camel (not found in types.ts)${NC}"
    fi
done

echo ""
echo -e "${BLUE}5. Recommendations:${NC}"
echo ""

if [ "$all_good" = true ]; then
    echo -e "${GREEN}✅ All critical fields present in schema!${NC}"
else
    echo -e "${RED}❌ Some fields are missing. Review above output.${NC}"
fi

echo ""
echo "Manual checks to perform:"
echo "  1. Verify all TypeScript interface fields have database columns"
echo "  2. Ensure naming convention is consistent (camelCase in TS, snake_case in DB)"
echo "  3. Check for optional vs required fields match"
echo "  4. Verify data types align (string → text/varchar, number → integer/numeric)"
echo ""

echo -e "${BLUE}6. Quick Database Connection Test:${NC}"
echo ""

# Try to query Supabase (using curl)
echo "Testing Supabase connection..."

# We need to use the anon key for basic connection test
response=$(curl -s -o /dev/null -w "%{http_code}" "${SUPABASE_URL}/rest/v1/" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}")

if [ "$response" = "200" ] || [ "$response" = "406" ]; then
    echo -e "${GREEN}✓ Supabase connection successful${NC}"
else
    echo -e "${YELLOW}⚠ Supabase connection returned status: $response${NC}"
fi

echo ""
echo "================================================"
echo -e "${BLUE}✨ Verification complete!${NC}"
echo ""
echo "For detailed schema verification, use:"
echo "  psql \$DATABASE_URL -f database/snapshot/verify_current_state.sql"
echo ""
echo "To sync any changes:"
echo "  1. Create migration: cp database/migrations/template.sql database/migrations/YYYYMMDD_change.sql"
echo "  2. Apply migration: psql \$DATABASE_URL -f database/migrations/YYYYMMDD_change.sql"
echo "  3. Update types.ts to match"
echo "  4. Commit both files together"
echo ""
